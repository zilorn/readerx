import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as solid from "../node_modules/solid-js/dist/solid.js";

// 运行实际显示派生、分句、播放器与 HTTP/缓存链路；只替换原生宿主和音频设备。
let storedRules = [];
const requests = [];
const disk = new Map();
const logs = [];
let failRequests = false;
globalThis.window = globalThis;
globalThis.fetch = async (url) => {
  const text = new URL(url).searchParams.get("text");
  requests.push(text);
  if (failRequests) return new Response(null, { status: 500 });
  return new Response(new TextEncoder().encode(text), {
    headers: { "content-type": "audio/wav" },
  });
};
const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [
  level, (...args) => logs.push(args),
]));
const mocks = {
  "solid-js": solid,
  "@tauri-apps/api/core": { isTauri: () => false },
  "@tauri-apps/plugin-http": { fetch: globalThis.fetch },
  "./backend": {
    readState: async (key) => key === "readerx.textReplacements" ? storedRules : {
      engine: "http", httpUrl: "https://tts.invalid/?text={$TEXT}",
    },
    writeState: async () => {},
  },
  "./dataIds": { replaceRuleId: (rule) => rule.id },
  "./i18n": { t: (key) => key },
  "./logger": { createLogger: () => logger },
  "./hanConvert": { hanVersion: () => 0 },
  "./errorReport": { describeError: String },
  "./audioCache": {
    readTtsAudioCache: async (bookId, key) => disk.get(`${bookId}:${key}`) ?? null,
    writeTtsAudioCache: async (bookId, key, data, mime) => {
      disk.set(`${bookId}:${key}`, { data, mime });
    },
  },
  "./ttsEngine": { stopNativeSpeech: async () => {} },
  "./ttsDecodeGuide": { isLinuxDesktop: () => false },
  "./webAudio": {
    decodeAudio: async (bytes) => bytes,
    createSourceNode: () => ({ start() {} }),
    resumeAudioContext: async () => {},
    pauseAudioContext: async () => {},
    stopSourceNode: () => {},
  },
};
const modules = new Map();
function load(name) {
  if (mocks[name]) return mocks[name];
  if (modules.has(name)) return modules.get(name);
  const source = readFileSync(new URL(`../src/lib/${name.slice(2)}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  modules.set(name, exports);
  new Function("require", "exports", outputText)(load, exports);
  return exports;
}
const replacements = load("./textReplacements");
const { withHanBook } = load("./hanDisplay");
const { createTtsPlayer } = load("./ttsPlayer");
await load("./ttsSettings").ensureTtsPrefsLoaded();

const raw = {
  id: "book", title: "测试", author: "", chapters: [
    { cid: "one", title: "", paragraphs: ["錯字。末句。"] },
    { cid: "two", title: "", paragraphs: [], blocks: [
      { kind: "h", level: 2, text: "錯字。" },
      { kind: "img", src: "test" },
      { kind: "p", text: "编号12。噪声。" },
    ] },
  ],
};
const original = JSON.stringify(raw);
const rule = (replace) => ({
  id: "literal", scope: "global", bookId: "", find: "錯字", replace,
  regex: false, createdAt: 1,
});
const regex = {
  ...rule("序号$1"), id: "regex", scope: "book", bookId: raw.id,
  find: "编号(\\d+)", regex: true,
};
const deletion = { ...rule(""), id: "delete", find: "噪声。" };
async function setRules(rules) {
  storedRules = rules;
  await replacements.reloadTextReplacements();
}

// 提取 Reader 真正使用的显示派生与播放器章节接线，避免测试另造一条文本路径。
const reader = ts.createSourceFile("Reader.tsx", readFileSync(
  new URL("../src/pages/Reader.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let bookExpression;
let context;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(reader) === "book") {
    bookExpression = node.initializer.getText(reader);
  }
  if (ts.isCallExpression(node) && node.expression.getText(reader) === "createTtsPlayer") {
    context = node.arguments[0];
  }
  ts.forEachChild(node, visit);
}
visit(reader);
assert.ok(bookExpression && context);
const property = (name) => context.properties.find((node) => node.name?.getText(reader) === name)
  .initializer.getText(reader);
const evaluate = (expression, dependencies) => {
  const { outputText } = ts.transpileModule(`const value = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(...Object.keys(dependencies), `${outputText}; return value;`)(
    ...Object.values(dependencies),
  );
};
let book;
const dispose = solid.createRoot((cleanup) => {
  book = evaluate(bookExpression, {
    createMemo: solid.createMemo, withHanBook,
    withDisplayReplacements: replacements.withDisplayReplacements,
    rawBook: () => raw, bookId: () => raw.id,
  });
  return cleanup;
});
const chapterAt = evaluate(property("chapterAt"), { book });
const chapterCount = evaluate(property("chapterCount"), { book });
function player(pageOffsets) {
  return createTtsPlayer({
    bookId: () => raw.id, chapterIndex: () => 0, chapterAt, chapterCount,
    navigateChapter: () => {}, readingOffset: () => 0, pageOffsets,
  });
}
async function settle(check) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("听书操作未在预期时间内完成");
}

await setRules([rule("正字"), regex, deletion,
  { ...rule("别书"), id: "other", scope: "book", bookId: "other" },
]);
const warm = player(async () => []);
warm.warmup();
await settle(() => requests.length === 2 && disk.size === 2);
assert.deepEqual(requests, ["正字。", "末句。"], "章节窗口预热使用显示文本");
requests.length = 0;
assert.equal(await warm.warmBook(), 4);
assert.deepEqual(requests, ["序号12。"], "整本预热应用书籍正则与删除规则，并复用相同句子缓存");
warm.start();
await settle(() => warm.status() === "playing");
assert.equal(warm.focus().item.text, "正字。");
assert.deepEqual(requests, ["序号12。"], "播放复用同文本的预热磁盘缓存");
warm.dispose();

// 同长度替换不改变句子坐标或分页边界，旧实现会继续使用旧句子 / 旧音频。
for (const pageOffsets of [undefined, async () => [], async () => [3]]) {
  load("./ttsSettings").setTtsPageSplit(!!pageOffsets);
  disk.clear();
  requests.length = 0;
  await setRules([rule("正字")]);
  const active = player(pageOffsets);
  active.start();
  await settle(() => active.status() === "playing" && disk.size === 2);
  await setRules([rule("新字")]);
  active.prev();
  await settle(() => active.status() === "playing");
  assert.equal(active.focus().item.text, "新字。", "边界不变也必须刷新显示副本的分句");
  assert.ok(requests.includes("新字。"), "同坐标的新文本不能命中旧内存音频");
  await setRules([]);
  active.prev();
  await settle(() => active.status() === "playing");
  assert.equal(active.focus().item.text, "錯字。", "删除规则后恢复原文");
  assert.ok(requests.includes("錯字。"));
  await setRules([{ ...rule(""), find: ".+", regex: true }]);
  active.prev();
  await settle(() => active.status() === "stopped");
  assert.equal(active.focus(), null, "正文被全部删除后停止旧句，不留下旧焦点");
  active.dispose();
}

// 失败日志也不能携带正文或包含正文的内存缓存键。
disk.clear();
failRequests = true;
await setRules([rule("新字")]);
const failedWarmup = player();
const logStart = logs.length;
failedWarmup.warmup();
await settle(() => logs.slice(logStart).some((args) => args[0] === "章节窗口预热结束"));
failedWarmup.dispose();

assert.equal(JSON.stringify(raw), original, "显示与听书都不能改写原书");
assert.ok(!JSON.stringify(logs).includes("正字") && !JSON.stringify(logs).includes("新字"),
  "日志不能输出句子文本或含文本的缓存键");
dispose();
process.stdout.write("TTS 显示替换回归通过：窗口/整本预热、播放与缓存、规则更新/删除及原文隔离\n");
