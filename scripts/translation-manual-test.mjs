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

// Metadata translation uses the real provider, shared budget, settings and storage.
const metadata = await load("lib/translation/metadata.ts", {
  "solid-js": solid, "../i18n": i18n, "../errorReport": { reportFailure: () => assert.fail("unexpected metadata failure") },
  "../logger": { createLogger: () => ({ warn: () => {} }) },
  "./core": core, "./engine": engine, "./provider": provider, "./settings": settings, "./title": title,
});
await settings.saveTranslationSettings({ enabled: true, parallel: 1, protocol: "chat" });
assert.equal(settings.normalizeSettings({}).autoTranslateMetadata, false, "legacy settings default automatic metadata translation off");
const described = { ...book, id: "described-book", intro: "A traveller discovers a forgotten city.\nAn adventure begins." };
await backend.saveRemoteBook(described);
requests = [];
await metadata.translateBookMetadata(described, settings.effectiveTranslationSettings(described.id), signal);
assert.deepEqual(requests, [[described.title, described.intro]], "one action translates both fields, without chapter or glossary requests");
assert.deepEqual(metadata.metadataTranslations(described, settings.effectiveTranslationSettings(described.id)), { title: "译:" + described.title, intro: "译:" + described.intro });
assert.deepEqual(await backend.getRemoteBook(described.id), described, "metadata translations never overwrite original metadata");
await metadata.translateBookMetadata(described, settings.effectiveTranslationSettings(described.id), signal);
assert.equal(requests.length, 1, "saved metadata is reused");
await metadata.translateBookMetadata(described, settings.effectiveTranslationSettings(described.id), signal, true);
assert.equal(requests.length, 2, "retranslation refreshes both fields");
const savedMetadata = structuredClone(await backend.readTranslationBook(described.id));
fail = true;
await assert.rejects(metadata.translateBookMetadata(described, settings.effectiveTranslationSettings(described.id), signal, true));
assert.deepEqual(await backend.readTranslationBook(described.id), savedMetadata, "failed retranslation preserves both successful fields");
fail = false;
resolve = undefined;
pending = () => new Promise(done => { resolve = done; });
const metadataAbort = new AbortController();
const lateMetadata = metadata.translateBookMetadata(described, settings.effectiveTranslationSettings(described.id), metadataAbort.signal, true);
while (!resolve) await new Promise(done => setImmediate(done));
metadataAbort.abort(); resolve();
await assert.rejects(lateMetadata, { name: "AbortError" });
assert.deepEqual(await backend.readTranslationBook(described.id), savedMetadata, "cancelled retranslation cannot persist late metadata");
pending = undefined;
const changed = { ...described, intro: "An edited description." };
assert.equal(metadata.metadataTranslations(changed, settings.effectiveTranslationSettings(described.id)).intro, undefined, "edited descriptions hide stale translations");
assert.equal(metadata.metadataTranslations(described, { ...settings.translationSettings(), target: "ja" }).intro, undefined, "targets isolate description caches");
const reloadMetadataSettings = await load("lib/translation/settings.ts", { "solid-js": solid, "./types": types, "../backend": backend });
await reloadMetadataSettings.ensureTranslationBook(described.id);
assert.deepEqual(reloadMetadataSettings.translationBookState(described.id), savedMetadata, "description translation survives reloading settings");

requests = [];
const preview = { title: "Discovery book", intro: "A discovery description." };
await metadata.translateBookMetadata(preview, settings.translationSettings(), signal);
assert.deepEqual(metadata.metadataTranslations(preview, settings.translationSettings()), { title: "译:" + preview.title, intro: "译:" + preview.intro });
await metadata.translateBookMetadata(preview, settings.translationSettings(), signal);
assert.equal(requests.length, 1, "discovery reuses session cache without a shelf record");
await metadata.translateBookMetadata({ title: "No description", intro: "  " }, settings.translationSettings(), signal);
assert.deepEqual(requests.at(-1), ["No description"], "empty descriptions are not sent");

const beforeAutomatic = requests.length;
let ui, dispose;
let setActive, setAutomatic, setPreview;
solid.createRoot(stop => {
  dispose = stop;
  const [active, updateActive] = solid.createSignal(true);
  const [automatic, updateAutomatic] = solid.createSignal(false);
  const [current, updateCurrent] = solid.createSignal({ title: "Automatic discovery", intro: "Automatically translated description." });
  setActive = updateActive; setAutomatic = updateAutomatic; setPreview = updateCurrent;
  ui = metadata.createMetadataTranslation(current, { active, automatic });
});
const tick = () => new Promise(done => setImmediate(done));
await tick(); await tick();
assert.equal(ui.enabled(), true);
assert.equal(requests.length, beforeAutomatic, "opening a page with automatic translation off sends nothing");
setAutomatic(true);
for (let i = 0; i < 30 && !ui.hasTranslation(); i++) await tick();
assert.equal(ui.title(), "译:Automatic discovery");
assert.equal(ui.intro(), "译:Automatically translated description.");
assert.equal(requests.length, beforeAutomatic + 1);
ui.toggleOriginal();
assert.equal(ui.title(), "Automatic discovery");
ui.toggleOriginal();
assert.equal(ui.title(), "译:Automatic discovery");
setActive(false);
setPreview({ title: "Hidden discovery", intro: "No hidden requests." });
await tick();
assert.equal(requests.length, beforeAutomatic + 1, "kept discovery page stops background translation when inactive");
setActive(true);
for (let i = 0; i < 30 && !ui.hasTranslation(); i++) await tick();
assert.equal(ui.title(), "译:Hidden discovery");
resolve = undefined;
pending = () => new Promise(done => { resolve = done; });
setPreview({ title: "Old discovery", intro: "Old description." });
while (!resolve) await tick();
setActive(false); resolve(); await tick();
assert.equal(ui.hasTranslation(), false, "late results from a hidden discovery page cannot enter the cache");
pending = undefined;
setAutomatic(false); setActive(true);
await tick();
assert.equal(ui.title(), "Old discovery");
await ui.run();
assert.equal(ui.title(), "译:Old discovery");
setPreview({ title: "Old discovery", intro: "An enriched description." });
await tick();
assert.equal(ui.complete(), false, "a translated title alone does not mark an enriched description complete");
await ui.run(ui.complete());
assert.deepEqual(requests.at(-1), ["An enriched description."], "partial metadata hits translate only missing fields");
assert.equal(ui.complete(), true);
await ui.run(ui.complete());
assert.deepEqual(requests.at(-1), ["Old discovery", "An enriched description."], "completed metadata can force-refresh both fields");
await settings.saveTranslationSettings({ enabled: false });
assert.equal(ui.title(), "Old discovery", "global disable restores original metadata");
dispose();

// Metadata requests share the engine concurrency budget, including queued cancellation.
await settings.saveTranslationSettings({ enabled: true });
const releases = [];
let concurrent = 0, maxConcurrent = 0;
pending = () => new Promise(done => {
  concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
  releases.push(() => { concurrent--; done(); });
});
const first = metadata.translateBookMetadata({ title: "Budget one" }, settings.translationSettings(), signal);
while (!releases.length) await tick();
const queuedAbort = new AbortController();
const second = metadata.translateBookMetadata({ title: "Budget two" }, settings.translationSettings(), queuedAbort.signal);
queuedAbort.abort();
await assert.rejects(second, { name: "AbortError" });
const third = metadata.translateBookMetadata({ title: "Budget three" }, settings.translationSettings(), signal);
releases.shift()();
await first;
while (!releases.length) await tick();
releases.shift()();
await third;
assert.equal(maxConcurrent, 1);
pending = undefined;
console.log("metadata translation regression passed: title/description, persistence, cache/refresh, failure/cancel, defaults, auto toggle, active page, original display, shared concurrency");
