import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function load(path, imports) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => {
    assert.ok(name in imports, name);
    return imports[name];
  }, exports);
  return exports;
}
const sources = await load("../src/lib/translation/sources.ts", {});
const backend = await load("../src/lib/backend.ts", {
  "./dataIds": {},
  "@tauri-apps/api/core": { isTauri: () => false },
  "./booksTypes": {},
  "./errorReport": { reportFailure: () => assert.fail("Unexpected backend failure") },
  "./external": {},
  "./i18n": { t: (key) => key },
  "./logger": { createLogger: () => ({}) },
  "./translation/sources": sources,
});
const book = {
  id: "book", chapters: [
    { cid: "one", title: "One", paragraphs: ["Original word", "Keep this"] },
    { cid: "two", title: "Two", paragraphs: ["Other chapter"] },
  ],
};
const entry = (source, kind = "paragraph") => ({ source, kind, text: "译:" + source });
async function write(cid, entries) {
  const { revision } = await backend.readTranslationCache(book.id, cid);
  assert.equal(await backend.putTranslationCache(book.id, cid, revision, entries), true);
  return revision;
}
async function keys(cid) {
  return Object.keys((await backend.readTranslationCache(book.id, cid)).entries).sort();
}
await backend.saveRemoteBook(book);
const oldRevision = await write("one", {
  changed: entry("Original word"),
  unchanged: entry("Keep this"),
  anotherProvider: entry("Keep this"),
  selected: entry("word", "selection"),
  crossParagraph: entry("word\n\nKeep", "selection"),
});
await write("two", { other: entry("Other chapter") });
await backend.invalidateRemoteTranslations(book.id, "one");
assert.equal((await keys("one")).length, 5, "starting/failed/cancelled reload preserves source-matched cache");
assert.equal(await backend.putTranslationCache(book.id, "one", oldRevision, { late: entry("Original word") }), false);
const edited = { ...book.chapters[0], paragraphs: ["Keep this", "Original word extended", "Inserted"] };
await backend.saveRemoteBookChapters(book.id, [{ index: 0, chapter: edited }]);
assert.deepEqual(await keys("one"), ["anotherProvider", "selected", "unchanged"]);
assert.deepEqual(await keys("two"), ["other"], "edits do not affect other chapters");
const current = await backend.readTranslationCache(book.id, "one");
assert.equal(current.entries.unchanged, "译:Keep this", "unchanged translation remains usable");
assert.equal(await backend.putTranslationCache(book.id, "one", current.revision, {
  valid: entry("Inserted"), invalid: entry("No longer in the chapter"),
}), false);
assert.deepEqual(await keys("one"), ["anotherProvider", "selected", "unchanged"], "mixed invalid batch is atomic");
await backend.saveRemoteBook({ ...book, chapters: [book.chapters[1], edited] });
assert.deepEqual(await keys("one"), ["anotherProvider", "selected", "unchanged"], "chapter reordering preserves cache by cid");
await backend.saveRemoteBookChapters(book.id, [{ index: 1, chapter: { ...edited, paragraphs: ["Keep this", "Keep this", "Inserted"] } }]);
assert.deepEqual(await keys("one"), ["anotherProvider", "unchanged"], "removed selection source is deleted; duplicate unchanged paragraphs remain reusable");
await backend.saveRemoteBook({ ...book, chapters: [book.chapters[1]] });
await assert.rejects(backend.readTranslationCache(book.id, "one"), /stale/);
assert.deepEqual(await keys("two"), ["other"]);
// Reusing a removed cid cannot resurrect translations or accept a pre-removal response.
await backend.saveRemoteBook(book);
assert.deepEqual(await keys("one"), []);
assert.equal(await backend.putTranslationCache(book.id, "one", oldRevision, { late: entry("Original word") }), false);

const structured = { cid: "blocks", title: "Blocks", paragraphs: ["Stale fallback"], blocks: [
  { kind: "h", level: 2, text: "Heading" },
  { kind: "p", text: "First 😀 paragraph" },
  { kind: "img", src: "before.png" },
  { kind: "p", text: "Last" },
] };
await backend.saveRemoteBook({ ...book, chapters: [structured] });
await write("blocks", { first: entry("First 😀 paragraph"), selection: entry("paragraphLast", "selection") });
structured.blocks[2].src = "after.png";
await backend.saveRemoteBookChapters(book.id, [{ index: 0, chapter: structured }]);
assert.deepEqual(await keys("blocks"), ["first", "selection"], "image-only change preserves translations");
assert.equal(sources.translationSourceMatches(structured, entry("Stale fallback")), false);
assert.equal(sources.translationSourceMatches(structured, entry("Heading")), false, "headings are not paragraphs");
assert.equal(sources.translationSourceMatches(structured, entry("paragraph\nLast", "selection")), true);
assert.equal(sources.translationSource(structured, "Display replacement"), undefined, "unmatched display text must not enter the original-text cache");
structured.blocks[3].text = "Changed";
await backend.saveRemoteBookChapters(book.id, [{ index: 0, chapter: structured }]);
assert.deepEqual(await keys("blocks"), ["first"]);
await backend.deleteRemoteBook(book.id);
await backend.saveRemoteBook({ ...book, chapters: [structured] });
assert.deepEqual(await keys("blocks"), [], "deleting/recreating a book does not resurrect its cache");
console.log("translation storage regression passed: source matching, selective deletion, reload preservation, late responses, reorder/removal, structured blocks, selections, atomic writes");
