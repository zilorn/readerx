import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as solid from "../node_modules/solid-js/dist/solid.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

async function load(path, imports) {
  const source = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function("require", "exports", outputText)(name => {
    assert.ok(name in imports, name);
    return imports[name];
  }, exports);
  return exports;
}
const i18n = { t: key => key };
const types = await load("lib/translation/types.ts", {});
const core = await load("lib/translation/core.ts", {
  "@noble/hashes/sha2.js": { sha256 }, "@noble/hashes/utils.js": { bytesToHex },
});
const sources = await load("lib/translation/sources.ts", {});
const backend = await load("lib/backend.ts", {
  "./dataIds": {}, "@tauri-apps/api/core": { isTauri: () => false }, "./booksTypes": {},
  "./errorReport": { reportFailure: () => assert.fail("unexpected backend failure") },
  "./external": {}, "./i18n": i18n, "./logger": { createLogger: () => ({}) },
  "./translation/sources": sources,
});
const settings = await load("lib/translation/settings.ts", { "solid-js": solid, "./types": types, "../backend": backend });
const title = await load("lib/translation/title.ts", {
  "solid-js": solid, "../bookDisplay": { bookDisplayTitle: text => text },
  "../errorReport": {}, "../i18n": i18n, "./core": core, "./settings": settings,
});
let requests = [], pending, fail = false;
const provider = await load("lib/translation/provider.ts", {
  "./core": core, "../i18n": i18n,
  "../http": { httpFetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    const input = JSON.parse(body.input ?? body.messages[1].content);
    requests.push(input.paragraphs.map(row => row.text));
    if (pending) await pending(init.signal);
    if (fail) throw new Error("SECRET response");
    const text = JSON.stringify({ translations: input.paragraphs.map(row => ({ id: row.id, text: "译:" + row.text })) });
    return new Response(JSON.stringify(body.input ? { output: [{ type: "message", content: [{ type: "output_text", text }] }] } : { choices: [{ message: { content: text } }] }));
  } },
});
const engine = await load("lib/translation/engine.ts", {
  "solid-js": solid, "../backend": backend, "../i18n": i18n, "./settings": settings,
  "./provider": provider, "./core": core, "./sources": sources,
  "../pagination": { chapterUnits: ch => ch.blocks ?? ch.paragraphs.map(text => ({ kind: "p", text })) },
});
const manual = await load("lib/translation/manual.ts", {
  "../i18n": i18n, "./core": core, "./engine": engine, "./provider": provider,
  "../logger": { createLogger: () => ({ info: () => {} }) },
  "./settings": settings, "./title": title,
});
const book = { id: "manual-book", title: "The Long Journey", chapters: [
  { cid: "one", paragraphs: Array.from({ length: 17 }, (_, i) => `First chapter paragraph ${i}`) },
  { cid: "missing", paragraphs: [] },
  { cid: "image", paragraphs: [], blocks: [{ kind: "img", src: "image.png" }] },
  { cid: "two", paragraphs: ["Stale fallback"], blocks: [{ kind: "h", text: "Heading" }, { kind: "p", text: "Downloaded structured paragraph" }] },
] };
await backend.saveRemoteBook(book);
await settings.saveTranslationSettings({ enabled: true, provider: "openai", model: "test", folded: true, mode: "original", pretranslate: 0 });
await settings.ensureTranslationBook(book.id);
const signal = new AbortController().signal;
assert.equal(title.translatedBookTitle(book), undefined, "old books default to their original titles");
await manual.translateBookTitle(book, signal);
assert.equal(title.translatedBookTitle(book), "译:" + book.title);
assert.deepEqual(requests, [[book.title]], "title action must not request content or a glossary");
assert.equal((await backend.getRemoteBook(book.id)).title, book.title, "metadata stays original");
await settings.saveTranslationBook(book.id, { titleEnabled: false });
assert.equal(title.translatedBookTitle(book), undefined);
await manual.translateBookTitle(book, signal);
assert.equal(requests.length, 1, "reenabling the title reuses the matching cache");
await manual.translateBookTitle(book, signal, true);
assert.equal(requests.length, 2, "explicit retranslation bypasses the title cache");
await settings.saveTranslationBook(book.id, { terms: [{ source: "Journey", target: "旅程", note: "" }], glossaryTarget: "zh-CN" });
await settings.saveTranslationSettings({ glossary: true });
assert.equal(title.translatedBookTitle(book), "译:" + book.title, "creating a glossary must not hide the enabled title");
await settings.saveTranslationSettings({ glossary: false });
assert.equal(title.translatedBookTitle({ ...book, title: "Edited name" }), undefined, "edits cannot display a stale title");
for (const patch of [{ target: "ja" }, { model: "other" }, { apiKey: "other" }]) {
  const original = settings.translationSettings();
  await settings.saveTranslationSettings(patch);
  assert.equal(title.translatedBookTitle(book), undefined, "configurations isolate title translations");
  await settings.saveTranslationSettings(original);
}
const beforeFailure = structuredClone(await backend.readTranslationBook(book.id));
fail = true;
await assert.rejects(manual.translateBookTitle(book, signal, true), /networkError/);
assert.deepEqual(await backend.readTranslationBook(book.id), beforeFailure, "failure preserves the last title and toggle");
const newBook = { ...book, id: "failed-first-title" };
await backend.saveRemoteBook(newBook);
await assert.rejects(manual.translateBookTitle(newBook, signal), /networkError/);
assert.equal(settings.translationBookState(newBook.id).titleEnabled, undefined, "a failed first attempt must keep the title toggle off");
fail = false;
let resolve;
pending = () => new Promise(done => { resolve = done; });
const cancelled = new AbortController();
const task = manual.translateBookTitle(book, cancelled.signal, true);
while (!resolve) await new Promise(done => setImmediate(done));
cancelled.abort(); resolve();
await assert.rejects(task, { name: "AbortError" });
assert.deepEqual(await backend.readTranslationBook(book.id), beforeFailure, "late cancelled title results cannot persist");
pending = undefined;
// A newly loaded settings module sees the persisted title, while legacy state remains valid.
const reloaded = await load("lib/translation/settings.ts", { "solid-js": solid, "./types": types, "../backend": backend });
await reloaded.ensureTranslationBook(book.id);
assert.deepEqual(reloaded.translationBookState(book.id), beforeFailure);

requests = [];
const progress = [];
await manual.translateBookContent(book, signal, value => progress.push(value));
assert.deepEqual(requests.map(rows => rows.length), [15, 2, 1]);
assert.equal(progress.at(-1).completed, 2);
assert.equal(progress.at(-1).total, 2, "only downloaded text chapters are counted");
assert.ok(!requests.flat().includes("Stale fallback"));
await manual.translateBookContent(book, signal, () => {});
assert.equal(requests.length, 3, "second click uses the persisted paragraph cache");
const original = await backend.getRemoteBook(book.id);
assert.deepEqual(original, book, "content action never rewrites original book data");
await settings.saveTranslationSettings({ protocol: "responses" });
requests = [];
const stop = new AbortController();
await assert.rejects(manual.translateBookContent(book, stop.signal, value => {
  if (value.completed === 1) stop.abort();
}), { name: "AbortError" });
assert.equal(requests.length, 2, "cancel after one chapter does not start the next chapter");
await manual.translateBookContent(book, signal, () => {});
assert.equal(requests.length, 3, "resume translates only the remaining chapter");
await assert.rejects(manual.translateBookContent({ ...book, chapters: [] }, signal, () => {}), /noSamples/);
await settings.saveTranslationSettings({ enabled: false });
assert.equal(title.translatedBookTitle(book), undefined, "global disable hides title translations");
const count = requests.length;
await assert.rejects(manual.translateBookTitle(book, signal), /disabled/);
await assert.rejects(manual.translateBookContent(book, signal, () => {}), /disabled/);
assert.equal(requests.length, count, "disabled translation never requests the provider");
console.log("manual translation regression passed: title toggle/cache/persistence/configuration, original data preservation, downloaded chapters, batching, cancellation, resume, both AI protocols");
