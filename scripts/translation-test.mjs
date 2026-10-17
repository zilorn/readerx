import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as solid from "../node_modules/solid-js/dist/solid.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
const { createRoot, createSignal } = solid;
function load(path, imports) {
  return readFile(
    new URL(`../src/lib/translation/${path}.ts`, import.meta.url),
    "utf8",
  ).then((source) => {
    const code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const exports = {};
    new Function("require", "exports", code)((name) => {
      assert.ok(name in imports, name);
      return imports[name];
    }, exports);
    return exports;
  });
}
const i18n = {
  t: (key, params) => key + (params ? JSON.stringify(params) : ""),
};
const types = await load("types", {});
const core = await load("core", {
  "@noble/hashes/sha2.js": { sha256 },
  "@noble/hashes/utils.js": { bytesToHex },
});
const sources = await load("sources", {});
const defaults = { ...types.DEFAULT_TRANSLATION_SETTINGS, enabled: true };
assert.equal(
  core.foreignBook([
    {
      paragraphs: [
        "This is an English paragraph with enough letters to identify the foreign language. ".repeat(
          5,
        ),
      ],
    },
  ]),
  true,
);
assert.equal(
  core.foreignBook([
    { paragraphs: ["这是中文书籍的正文，里面没有需要翻译的内容。".repeat(10)] },
  ]),
  false,
);
assert.equal(
  core.foreignBook([{ paragraphs: ["これは日本語の小説です。".repeat(10)] }]),
  true,
);
assert.equal(core.alreadyTarget("これは日本語の小説です", "zh-CN"), false);
assert.equal(core.alreadyTarget("这是已经翻译好的中文正文", "zh-CN"), true);
for (const text of [
  "Das war alles, was er wusste.", "Was ist das?", "To jest dobra książka.",
  "Il a dit: this is the end. Puis il est parti.", "これはカタカナです。",
]) assert.equal(core.alreadyTarget(text, "en"), false, text);
assert.equal(core.alreadyTarget("The book is on the table.", "en"), false,
  "不可靠的拉丁语种判定交给服务，避免漏译");
const key = core.translationKey("text", defaults, []);
for (const patch of [
  { target: "ja" },
  { provider: "custom" },
  { apiKey: "secret" },
  { model: "other" },
  { effort: "high" },
])
  assert.notEqual(
    core.translationKey("text", { ...defaults, ...patch }, []),
    key,
  );
assert.notEqual(
  core.translationKey("text", defaults, [
    { source: "A", target: "B", note: "" },
  ]),
  key,
);
assert.equal(
  core.translationKey("text", defaults, [
    { source: "A", target: "B", note: "n" },
    { source: "C", target: "D", note: "" },
  ]),
  core.translationKey("text", defaults, [
    { note: "", target: "D", source: "C" },
    { note: "n", target: "B", source: "A" },
  ]),
  "术语表经 Rust JSON 字段排序或清单重排后，重启仍命中缓存",
);
const chapters = Array.from({ length: 100 }, (_, i) => ({
  paragraphs: Array.from({ length: 50 }, (_, j) =>
    `Chapter ${i}, paragraph ${j}. `.repeat(100),
  ),
}));
const samples = core.representativeSamples(chapters);
assert.ok(samples.join("").length <= 18024);
assert.ok(
  samples[0].includes("Chapter 0") && samples.at(-1).includes("Chapter 99"),
);
assert.deepEqual(
  core
    .paragraphBatches(Array.from({ length: 46 }, (_, i) => i))
    .map((batch) => batch.length),
  [15, 15, 15, 1],
);
assert.equal(
  Array.from(
    core.normalizeTerms([
      { source: " name ", target: "译名", note: "🙂".repeat(40) },
    ])[0].note,
  ).length,
  29,
);

let requests = [],
  response,
  failed = false;
const provider = await load("provider", {
  "../http": {
    httpFetch: async (url, init) => {
      requests.push({ url, init });
      if (failed)
        throw new Error("SECRET BODY https://secret.invalid?key=SECRET");
      return new Response(JSON.stringify(response), { status: 200 });
    },
  },
  "../i18n": i18n,
  "./core": core,
});
const signal = new AbortController().signal;
response = {
  output: [
    { type: "reasoning", content: [] },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({ translations: [{ id: 0, text: "译文" }] }),
        },
      ],
    },
  ],
};
assert.deepEqual(
  await provider.translateBatch(
    ["source"],
    {
      ...defaults,
      provider: "openai",
      model: "test",
      protocol: "responses",
      effort: "low",
    },
    [],
    signal,
  ),
  ["译文"],
);
const body = JSON.parse(requests[0].init.body);
assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
assert.equal(body.store, false);
assert.equal(body.reasoning.effort, "low");
assert.equal(body.text.format.type, "json_object");
response = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          translations: [
            { id: 1, text: "乙" },
            { id: 0, text: "甲" },
          ],
        }),
      },
    },
  ],
};
assert.deepEqual(
  await provider.translateBatch(
    ["a", "b"],
    {
      ...defaults,
      provider: "custom",
      baseUrl: "http://localhost:8000/v1",
      model: "local",
      apiKey: "SECRET",
    },
    [],
    signal,
  ),
  ["甲", "乙"],
);
assert.equal(requests.at(-1).init.headers.Authorization, "Bearer SECRET");
response.choices[0].message.content = JSON.stringify({
  translations: [
    { id: 0, text: "甲" },
    { id: 0, text: "乙" },
  ],
});
await assert.rejects(
  provider.translateBatch(
    ["a", "b"],
    { ...defaults, provider: "openai", model: "x" },
    [],
    signal,
  ),
  /invalidResponse/,
);
failed = true;
await assert.rejects(
  provider.translateBatch(
    ["secret source"],
    { ...defaults, provider: "custom", model: "x" },
    [],
    signal,
  ),
  (error) =>
    !error.message.includes("SECRET") && error.message.includes("networkError"),
);
failed = false;
response = [[["译文", "source"]]];
assert.deepEqual(
  await provider.translateBatch(["source"], defaults, [], signal),
  ["译文"],
);
await assert.rejects(
  provider.generateTerms(samples, defaults, signal),
  /aiRequired/,
);
assert.throws(
  () =>
    provider.providerEndpoint({ ...defaults, baseUrl: "file:///tmp/private" }),
  /invalidUrl/,
);

let disk = new Map(),
  reads = 0,
  writes = 0,
  revision = "1",
  failRead = false,
  stale = false;
let active = 0,
  peak = 0,
  calls = 0,
  batchSizes = [];
let termCalls = 0;
let generateTerms = async () => [];
const [readerSettings, setReaderSettings] = createSignal(defaults);
const [bookState, setBookState] = createSignal({ terms: [] });
const settings = {
  effectiveTranslationSettings: readerSettings,
  ensureTranslationBook: async () => {},
  ensureTranslationSettings: async () => {},
  translationBookState: bookState,
  saveTranslationBook: async (_, patch) =>
    setBookState((old) => ({ ...old, ...patch })),
};
const pagination = {
  chapterUnits: (chapter) =>
    chapter.paragraphs.map((text) => ({ kind: "p", text })),
};
const engine = await load("engine", {
  "solid-js": { createSignal },
  "../i18n": i18n,
  "./core": core,
  "./settings": settings,
  "./sources": sources,
  "../pagination": pagination,
  "../backend": {
    readTranslationCache: async () => {
      reads++;
      if (failRead) throw Error("read failed");
      return { revision, entries: Object.fromEntries(disk) };
    },
    putTranslationCache: async (_, __, expected, entries) => {
      writes++;
      if (stale || revision !== expected) return false;
      for (const entry of Object.values(entries)) {
        assert.equal(typeof entry.source, "string");
        assert.ok(["paragraph", "selection"].includes(entry.kind));
      }
      Object.entries(entries).forEach(([key, entry]) => disk.set(key, entry.text));
      return true;
    },
    invalidateRemoteTranslations: async () => {
      revision = String(Number(revision) + 1);
    },
  },
  "./provider": {
    generateTerms: async (...args) => {
      termCalls++;
      return generateTerms(...args);
    },
    translateBatch: async (texts, _, __, signal) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      batchSizes.push(texts.length);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        signal.throwIfAborted();
        return texts.map((text) => "译:" + text);
      } finally {
        active--;
      }
    },
  },
});
const chapter = { cid: "c", paragraphs: [] };
const texts = Array.from({ length: 46 }, (_, i) => `foreign ${i}`);
chapter.paragraphs = texts;
let batches = 0;
await engine.translatedTexts(
  "b",
  chapter,
  texts,
  defaults,
  [],
  signal,
  () => batches++,
);
assert.equal(calls, 4);
assert.equal(writes, 4);
assert.ok(peak <= defaults.parallel);
assert.deepEqual(
  batchSizes.sort((a, b) => a - b),
  [1, 15, 15, 15],
);
assert.equal(batches, 5);
await engine.translatedTexts("b", chapter, texts, defaults, [], signal);
assert.equal(calls, 4, "重进章节从落库译文读取，不再请求");
await engine.translatedTexts(
  "b",
  chapter,
  [texts[0], texts[0]],
  defaults,
  [],
  signal,
);
assert.equal(calls, 4, "相同划词文本命中段落缓存");
failRead = true;
const before = calls;
await assert.rejects(
  engine.translatedTexts("b", chapter, texts, defaults, [], signal),
  /read failed/,
);
assert.equal(calls, before, "读失败不得当作空缓存请求或覆盖");
failRead = false;
await engine.invalidateTranslations("b", "c");
assert.equal(disk.size, 46, "重取只推进租约，保留原文未变的译文");
disk.clear();
stale = true;
await assert.rejects(
  engine.translatedTexts("b", { ...chapter, paragraphs: ["changed"] }, ["changed"], defaults, [], signal),
  /stale/,
);
assert.equal(disk.size, 0);
stale = false;
const controller = new AbortController();
const cancelled = engine.translatedTexts(
  "b",
  chapter,
  texts,
  defaults,
  [],
  controller.signal,
);
setTimeout(() => controller.abort(), 1);
await assert.rejects(cancelled);
assert.equal(disk.size, 0, "取消后不落地请求结果");
const beforeUnmatched = writes;
const unmatchedText = "Display replacement absent from the original chapter";
const unmatched = await engine.translatedTexts("b", chapter, [unmatchedText], defaults, [], signal);
assert.equal(unmatched[core.translationKey(unmatchedText, defaults, [])], "译:" + unmatchedText);
assert.equal(writes, beforeUnmatched, "无法匹配原文的显示选区可翻译但不写入原文缓存");

// 使用真实 Solid 浏览器响应式运行时与翻译引擎，验证阅读调度和弹窗共用的按需入口。
const failures = [];
const readerModule = await load("reader", {
  "solid-js": solid,
  "../pagination": pagination,
  "./engine": engine,
  "./settings": settings,
  "./core": core,
  "../errorReport": { reportFailure: (...args) => failures.push(args) },
  "../i18n": i18n,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "翻译调度应在限定时间内完成");
    await tick();
  }
}
const readingBook = {
  id: "folded-book",
  chapters: Array.from({ length: 7 }, (_, index) => ({
    cid: `folded-${index}`,
    paragraphs: [
      `First paragraph of chapter ${index}.`,
      `Second paragraph of chapter ${index}.`,
    ],
  })),
};
for (const pretranslate of [0, 1, 5]) {
  disk.clear();
  setBookState({ terms: [] });
  setReaderSettings({
    ...defaults, folded: true, pretranslate, glossary: true,
    provider: "openai", model: "test",
  });
  const baseline = { calls, termCalls, reads, writes };
  const [book, setBook] = createSignal(readingBook);
  const [chapterIndex, setChapterIndex] = createSignal(0);
  let reader, dispose;
  createRoot((cleanup) => {
    dispose = cleanup;
    reader = readerModule.createReaderTranslation({
      bookId: () => readingBook.id,
      book,
      chapter: () => book().chapters[chapterIndex()],
      startUnit: () => 0,
      beforeChange: () => assert.fail("折叠浮窗不能触发正文重排"),
    });
  });
  try {
    await tick();
    assert.equal(termCalls, baseline.termCalls, "展开前不自动生成术语表");
    assert.equal(reader.busy(), false);
    setChapterIndex(1);
    setBook((old) => ({
      ...old,
      chapters: old.chapters.map((ch, index) => index === 2
        ? { ...ch, paragraphs: [...ch.paragraphs, "Newly downloaded online paragraph."] }
        : ch),
    }));
    reader.retry();
    await engine.invalidateTranslations(readingBook.id, book().chapters[1].cid);
    await tick();
    assert.deepEqual({ calls, termCalls, reads, writes }, baseline,
      `折叠模式忽略预翻译 ${pretranslate} 章，换章/在线正文到达/重试/缓存失效均不请求`);
    const current = book().chapters[1];
    const selected = current.paragraphs[0];
    assert.equal(reader.canFold(selected), true);
    assert.equal(await engine.selectionTranslation(book(), current, selected, signal), "译:" + selected);
    assert.equal(calls, baseline.calls + 1, "展开只翻译选中段落");
    assert.equal(batchSizes.at(-1), 1);
    assert.equal(termCalls, baseline.termCalls + 1, "首次展开才生成所需术语表");
    await tick();
    assert.equal(calls, baseline.calls + 1, "术语表更新后仍不触发后台翻译");
    await engine.selectionTranslation(book(), current, selected, signal);
    assert.equal(calls, baseline.calls + 1, "再次展开复用缓存");
    assert.deepEqual(reader.translations(), {});
    assert.equal(reader.failure(), "");
  } finally {
    dispose();
  }
}

// 折叠开关只约束双语模式；展开内嵌译文或切到仅译文仍沿用已保存的预翻译配置。
disk.clear();
setReaderSettings({ ...defaults, folded: true, pretranslate: 1 });
let reader, dispose;
createRoot((cleanup) => {
  dispose = cleanup;
  reader = readerModule.createReaderTranslation({
    bookId: () => readingBook.id,
    book: () => readingBook,
    chapter: () => readingBook.chapters[0],
    startUnit: () => 0,
    beforeChange: () => {},
  });
});
try {
  await tick();
  for (const mode of ["bilingual", "translated"]) {
    disk.clear();
    const before = calls;
    setReaderSettings({ ...defaults, mode, folded: mode === "translated", pretranslate: 1 });
    await until(() => !reader.busy());
    assert.equal(calls, before + 2, "当前章与后续一章正常翻译");
    assert.equal(Object.keys(reader.translations()).length, 2);
  }
  disk.clear();
  const before = calls;
  setReaderSettings({ ...defaults, pretranslate: 5 });
  await until(() => calls > before);
  setReaderSettings({ ...defaults, folded: true, pretranslate: 5 });
  await until(() => active === 0);
  assert.equal(calls, before + 1, "切回折叠模式取消在飞任务，不继续预翻译");
  assert.equal(disk.size, 0, "已取消的自动翻译不回填缓存");
  assert.equal(reader.busy(), false);
  assert.deepEqual(reader.translations(), {});
  assert.deepEqual(failures, []);
} finally {
  dispose();
}

// 旧术语表请求已取消但尚未收尾时，新章必须启动新请求；旧 finally 不得清掉它。
setBookState({ terms: [] });
const glossarySettings = { ...defaults, provider: "openai", model: "test", glossary: true };
const glossaryBook = { id: "glossary-switch", chapters: [chapter] };
const pendingTerms = [];
generateTerms = (_samples, _settings, signal) => new Promise((resolve, reject) => {
  pendingTerms.push({ resolve, reject, signal });
});
const oldController = new AbortController();
const firstGlossary = engine.bookTerms(glossaryBook, glossarySettings, oldController.signal);
await until(() => pendingTerms.length === 1);
oldController.abort();
const newController = new AbortController();
const nextGlossary = engine.bookTerms(glossaryBook, glossarySettings, newController.signal);
await until(() => pendingTerms.length === 2);
pendingTerms[0].reject(new DOMException("Aborted", "AbortError"));
await assert.rejects(firstGlossary, { name: "AbortError" });
const sharedGlossary = engine.bookTerms(glossaryBook, glossarySettings, signal);
await tick();
assert.equal(pendingTerms.length, 2, "旧任务收尾后，新任务仍可共享");
pendingTerms[1].resolve([{ source: "name", target: "译名", note: "" }]);
assert.deepEqual(await nextGlossary, await sharedGlossary);
assert.equal(bookState().glossaryTarget, defaults.target);
generateTerms = async () => [];

// 真实阅读调度：生成术语表期间换章，新章不需要点击重试。
disk.clear();
setBookState({ terms: [] });
setReaderSettings(glossarySettings);
const delayedTerms = [];
generateTerms = (_samples, _settings, signal) => new Promise((resolve, reject) => {
  delayedTerms.push({ resolve, reject, signal });
});
const [switchIndex, setSwitchIndex] = createSignal(0);
let switchReader, disposeSwitch;
createRoot(cleanup => {
  disposeSwitch = cleanup;
  switchReader = readerModule.createReaderTranslation({
    bookId: () => "glossary-switch-reader", book: () => readingBook,
    chapter: () => readingBook.chapters[switchIndex()], startUnit: () => 0,
    beforeChange: () => {},
  });
});
try {
  await until(() => delayedTerms.length === 1);
  setSwitchIndex(1);
  await until(() => delayedTerms.length === 2);
  assert.equal(delayedTerms[0].signal.aborted, true);
  delayedTerms[0].reject(new DOMException("Aborted", "AbortError"));
  const before = calls;
  delayedTerms[1].resolve([]);
  await until(() => !switchReader.busy());
  assert.equal(calls, before + 1);
  assert.equal(Object.keys(switchReader.translations()).length, 2);
  assert.equal(switchReader.failure(), "");
  const snapshot = { calls, termCalls, translations: switchReader.translations() };
  setReaderSettings(old => ({ ...old, readingText: "translated" }));
  await tick();
  assert.deepEqual({ calls, termCalls, translations: switchReader.translations() }, snapshot,
    "听书文本变化不重排或重启显示翻译");
} finally { disposeSwitch(); generateTerms = async () => []; }

// 手动重译绕过当前配置的缓存，仅请求所选章，不启动后续五章。
disk.clear();
setBookState({ terms: [] });
setReaderSettings({ ...defaults, mode: "original", folded: true, pretranslate: 5 });
const selectedChapter = readingBook.chapters[0];
await engine.translatedTexts(readingBook.id, selectedChapter, selectedChapter.paragraphs, readerSettings(), [], signal);
const beforeRefresh = calls;
await engine.retranslateChapter(readingBook, selectedChapter, signal);
assert.equal(calls, beforeRefresh + 1, "已缓存段落仍产生新的重译请求");
await engine.translatedTexts(readingBook.id, selectedChapter, selectedChapter.paragraphs, readerSettings(), [], signal);
assert.equal(calls, beforeRefresh + 1, "重译结果可被普通阅读复用");
const stopRefresh = new AbortController();
const cancelledRefresh = engine.retranslateChapter(readingBook, selectedChapter, stopRefresh.signal);
stopRefresh.abort();
await assert.rejects(cancelledRefresh, { name: "AbortError" });
setReaderSettings({ ...defaults, enabled: false });
await assert.rejects(engine.retranslateChapter(readingBook, selectedChapter, signal), /disabled/);
assert.deepEqual(failures, []);


// 旧配置默认原文听书；全局/本书读写分别合并，显示模式与听书文本互不改写。
let storedGlobal = { ...defaults, mode: "translated" };
delete storedGlobal.readingText;
const storedBooks = new Map();
const persistedSettings = await load("settings", {
  "solid-js": solid, "./types": types,
  "../backend": {
    readTranslationSettings: async () => structuredClone(storedGlobal),
    putTranslationSettings: async value => { storedGlobal = structuredClone(value); },
    readTranslationBook: async id => structuredClone(storedBooks.get(id) ?? { overrides: {}, terms: [] }),
    putTranslationBook: async (id, value) => { storedBooks.set(id, structuredClone(value)); },
  },
});
await persistedSettings.ensureTranslationSettings();
await persistedSettings.ensureTranslationBook("settings-book");
assert.equal(persistedSettings.translationSettings().readingText, "original");
await persistedSettings.setBookTranslationOverride("settings-book", { readingText: "translated" });
await persistedSettings.saveTranslationSettings({ mode: "bilingual" });
assert.equal(persistedSettings.translationSettings().readingText, "original");
assert.equal(persistedSettings.effectiveTranslationSettings("settings-book").readingText, "translated");
assert.equal(persistedSettings.effectiveTranslationSettings("settings-book").mode, "bilingual");
await Promise.all([
  persistedSettings.setBookTranslationOverride("settings-book", { mode: "original" }),
  persistedSettings.setBookTranslationOverride("settings-book", { glossary: true }),
  persistedSettings.saveTranslationSettings({ readingText: "translated" }),
]);
assert.deepEqual(storedBooks.get("settings-book").overrides, { readingText: "translated", mode: "original", glossary: true });
assert.equal(persistedSettings.translationSettings().mode, "bilingual");
assert.equal(persistedSettings.effectiveTranslationSettings("inherited").readingText, "translated");

console.log(
  "translation regression passed: cache, leases, cancellation, batches, concurrency, protocols, response validation, secret-safe failures, sampling, folded on-demand translation and pre-translation isolation",
);
