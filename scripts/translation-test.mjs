import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createSignal } from "solid-js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
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
const settings = {
  effectiveTranslationSettings: () => defaults,
  ensureTranslationBook: async () => {},
  ensureTranslationSettings: async () => {},
  translationBookState: () => ({ terms: [] }),
  saveTranslationBook: async () => {},
};
const engine = await load("engine", {
  "solid-js": { createSignal },
  "../i18n": i18n,
  "./core": core,
  "./settings": settings,
  "../pagination": {
    chapterUnits: (chapter) =>
      chapter.paragraphs.map((text) => ({ kind: "p", text })),
  },
  "../backend": {
    readTranslationCache: async () => {
      reads++;
      if (failRead) throw Error("read failed");
      return { revision, entries: Object.fromEntries(disk) };
    },
    putTranslationCache: async (_, __, expected, entries) => {
      writes++;
      if (stale || revision !== expected) return false;
      Object.entries(entries).forEach(([key, text]) => disk.set(key, text));
      return true;
    },
    invalidateRemoteTranslations: async () => {
      revision = "2";
      disk.clear();
    },
  },
  "./provider": {
    generateTerms: async () => [],
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
assert.equal(disk.size, 0);
stale = true;
await assert.rejects(
  engine.translatedTexts("b", chapter, ["changed"], defaults, [], signal),
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
console.log(
  "translation regression passed: cache, leases, cancellation, batches, concurrency, protocols, response validation, secret-safe failures, sampling",
);
