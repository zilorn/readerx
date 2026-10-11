import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createSignal } from "solid-js";

async function load(path, deps) {
  const code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => {
    assert.ok(name in deps, `Unexpected import ${name}`);
    return deps[name];
  }, exports);
  return exports;
}
const types = await load("../src/lib/booksTypes.ts", {});
const search = await load("../src/lib/onlineSearch.ts", { "./booksTypes": types });
const candidate = (name, source = "a", url = name) => ({ source: { id: source }, item: { bookName: name, bookUrl: url } });
let groups = search.mergeSearchResults([], Array.from({ length: 121 }, (_, i) => candidate(`book${i}`)));
assert.equal(groups.length, 120);
const before = groups;
groups = search.mergeSearchResults(groups, [candidate("book0", "b"), candidate("book0", "b"), candidate(" book0 ", "c"), candidate("book121")]);
assert.equal(groups.length, 120);
assert.equal(groups[0].candidates.length, 3);
assert.equal(before[0].candidates.length, 1);
assert.equal(search.toItem({ bookName: "invalid" }), null);
assert.equal(search.mergeSearchResults([], [candidate("A"), candidate("a")]).length, 2);

let book;
let writes = 0;
let fail = false;
let concurrent = false;
const online = await load("../src/lib/online.ts", {
  "solid-js": { createSignal },
  "./backend": {}, "./chapterImages": {}, "./bookmarks": {}, "./bookSources": {},
  "./sourceCover": {}, "./sourceContent": {}, "./booksTypes": types,
  "./logger": { createLogger: () => ({ info() {}, debug() {}, warn() {} }) },
  "./i18n": { t: (key) => key },
  "./books": {
    ensureLocalBookContent: async () => book,
    async updateBookContent(id, updater) {
      assert.equal(id, "stable-id");
      const latest = concurrent ? { ...book, bookSourceId: "other" } : book;
      const next = updater(latest);
      if (fail) throw new Error("disk full");
      book = next; writes++;
      return next;
    },
  },
});
const original = { id: "stable-id", format: "online", source: "online", title: "Book", author: "Author",
  bookSourceId: "old", bookUrl: "old-url", groupId: "group", tags: ["old-tag", "custom"], sourceTags: ["old-tag"],
  chapters: [{ cid: "c0001", title: "Old", url: "same-url", paragraphs: ["old text"], blocks: [{ kind: "p", text: "old" }] }] };
const fresh = [{ chapterName: "New", chapterUrl: "same-url" }];
const item = { bookName: "Book", bookUrl: "new-url", intro: "new intro", tags: ["new-tag"] };
book = structuredClone(original);
await online.switchOnlineBookSource(book.id, { id: "new" }, item, fresh);
assert.equal(book.id, original.id);
assert.equal(book.groupId, "group");
assert.equal(book.bookSourceId, "new");
assert.equal(book.bookUrl, "new-url");
assert.equal(book.intro, "new intro");
assert.deepEqual(book.tags, ["custom", "new-tag"]);
assert.deepEqual(book.chapters[0].paragraphs, []);
assert.equal(book.chapters[0].blocks, undefined);
assert.equal(writes, 1);
book = structuredClone(original); fail = true;
await assert.rejects(online.switchOnlineBookSource(book.id, { id: "new" }, item, fresh), /disk full/);
assert.deepEqual(book, original);
fail = false; concurrent = true;
await assert.rejects(online.switchOnlineBookSource(book.id, { id: "new" }, item, fresh), /tocChanged/);
concurrent = false;
await assert.rejects(online.switchOnlineBookSource(book.id, { id: "new" }, item, []), /tocEmpty/);
book = { ...original, format: "txt", source: "local" };
await assert.rejects(online.switchOnlineBookSource(book.id, { id: "new" }, item, fresh), /bookGone/);
assert.equal(writes, 1);
console.log("online sources: grouping, cap, deduplication, source replacement, failure, concurrent change and local-book guard passed");
