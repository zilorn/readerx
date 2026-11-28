import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as solid from "../node_modules/solid-js/dist/solid.js";

// 全局听书会话的生命周期回归：这里加载真实的 ttsSession / ttsPlayer，
// 只替换书库、在线补章、翻译、日志和音频设备，验证三件事：
// 1. 模块求值（createRoot 里构造播放器）不能抛异常——否则 App 启动即白屏；
// 2. 暂停后重开同一本书，初始章节恢复完成前不得重锚朗读位置；
// 3. 在线章节还没补齐时起播，换书后旧起播不能把新书读起来。

globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};

const files = new Map();
function makeBook(id, chapters) {
  return {
    id,
    title: `书 ${id}`,
    author: "",
    chapters: chapters.map((paragraphs, index) => ({
      cid: `${id}-${index}`,
      title: `第 ${index + 1} 章`,
      paragraphs,
    })),
  };
}
const books = new Map([
  ["A", makeBook("A", [["A0。"], ["A1。"], ["A2。"], ["A3。"]])],
  ["B", makeBook("B", [["B0。"], ["B1。"]])],
]);
books.get("A").online = true;

const logs = [];
const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [
  level, (...args) => logs.push([level, ...args]),
]));
const spoken = [];
let engine = "native";

// 分句在 tts-segment 回归里单独覆盖；这里每段一句，便于断言播放位置。
function buildChapterSpeechItems(chapter) {
  const items = [];
  let offset = 0;
  for (const [unit, text] of (chapter.paragraphs ?? []).entries()) {
    const value = String(text ?? "");
    if (value) {
      items.push({
        unit,
        ls: 0,
        le: value.length,
        start: offset,
        end: offset + value.length,
        isTitle: false,
        text: value,
      });
    }
    offset += value.length + 1;
  }
  return items;
}

// 在线补章闸门：测试 3 用它把「起播等待正文」卡在半路。
let gateEntered = false;
let releaseGate = null;
let ensureWindow = async () => {
  gateEntered = true;
  await new Promise((resolve) => { releaseGate = resolve; });
};

const mocks = {
  "solid-js": solid,
  "./books": {
    bookMetaById: (id) => books.get(id),
    ensureLocalBookContent: async () => {},
    localBookById: (id) => books.get(id),
  },
  "./booksTypes": { isOnlineBook: (value) => !!value?.online },
  "./hanDisplay": { withHanBook: (value) => value, hanText: (value) => value },
  "./textReplacements": { withDisplayReplacements: (value) => value },
  "./online": {
    chapterHasContent: (chapter) =>
      Array.isArray(chapter?.paragraphs) && chapter.paragraphs.length > 0,
    ensureReadingWindow: (...args) => ensureWindow(...args),
    onlineChapterFailure: () => null,
    onlineRunBusy: () => true,
  },
  "./translation/engine": { selectionTranslation: async (_book, _chapter, text) => text },
  "./translation/core": { translationKey: () => "" },
  "./translation/settings": {
    effectiveTranslationSettings: () => ({ enabled: false, readingText: "original" }),
    translationBookState: () => undefined,
  },
  "./toast": { showToast: () => {} },
  "./i18n": { t: (key) => key },
  "./logger": { createLogger: () => logger },
  "./ttsSegment": { buildChapterSpeechItems, splitSpeechItemsAtPages: (items) => items },
  "./ttsSettings": {
    currentTtsPageSplit: () => false,
    currentTtsEngine: () => engine,
    currentTtsRate: () => 1,
    currentTtsVoice: () => "test-voice",
    ensureTtsPrefsLoaded: async () => {},
    httpTtsConfigured: () => false,
    setTtsEngine: (value) => { engine = value; },
    setTtsRate: () => {},
    setTtsVoice: () => {},
  },
  "./ttsEngine": {
    describeNativeError: String,
    ensureNativeVoiceSelected: async () => "test-voice",
    isNativeTtsAvailable: () => true,
    nativeVoiceName: () => "test-voice",
    speakNativeSentence: async (text) => { spoken.push(text); },
    stopNativeSpeech: async () => {},
    subscribeNativeSpeechEvents: async () => () => {},
  },
  "./httpTts": {
    httpHasRatePlaceholder: () => false,
    httpRequestFingerprint: () => "",
    synthesizeHttpAudio: async () => { throw new Error("http engine not used"); },
  },
  "./webAudio": {
    createSourceNode: () => ({ start() {} }),
    decodeAudio: async (bytes) => bytes,
    pauseAudioContext: async () => {},
    resumeAudioContext: async () => {},
    stopSourceNode: () => {},
  },
  "./ttsDecodeGuide": { isLinuxDesktop: () => false },
  "./ttsService": { syncTtsForegroundService: () => {} },
};

function load(name) {
  if (mocks[name]) return mocks[name];
  if (files.has(name)) return files.get(name);
  const source = readFileSync(new URL(`../src/lib/${name.slice(2)}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  files.set(name, exports);
  new Function("require", "exports", outputText)(load, exports);
  return exports;
}

async function settle(check, label) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`未在预期时间内完成：${label}`);
}

// 1. 模块求值即构造会话：构造期不能读尚未赋值的播放器（App 启动白屏的根因）。
const session = load("./ttsSession");
const player = session.globalTtsPlayer();
assert.equal(player.status(), "stopped");
assert.equal(session.ttsSessionBookId(), null, "启动时不指向任何书");

let chapter = 0;
const binding = {
  bookId: "A",
  chapterIndex: () => chapter,
  navigateChapter: (index) => { chapter = index; },
  readingOffset: () => null,
  pageOffsets: async () => [],
};

// 先在 A 的第 2 章朗读，再暂停，得到「暂停在第 2 章」的会话。
session.claimTtsBook("A");
session.attachTtsReader(binding);
session.confirmTtsReaderView();
chapter = 2;
player.start();
await settle(() => player.status() === "playing" && player.focus()?.chapterIndex === 2, "A 第 2 章起播");
player.togglePlay();
await settle(() => player.status() === "paused", "暂停");

// 2. 离开阅读页后重开：挂载瞬间 chapterIdx 还是 0，恢复完成前不得重锚。
session.detachTtsReader("A");
assert.equal(player.focus()?.chapterIndex, 2, "离开阅读页保留暂停位置");
chapter = 0;
session.attachTtsReader(binding);
player.noteViewChapter(false); // 阅读页挂载时视图效果上报的暂态章节
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(player.status(), "paused");
assert.equal(player.focus()?.chapterIndex, 2, "初始恢复完成前不能按暂态章节重锚");
player.noteViewChapter(false);
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(player.focus()?.chapterIndex, 2, "重复上报同样不能重锚");
// 恢复落定：章节回到存档的第 2 章，此时才把视图交给会话。
chapter = 2;
session.confirmTtsReaderView();
player.noteViewChapter(false);
assert.equal(player.focus()?.chapterIndex, 2, "恢复落定后视图与朗读位置一致");
player.togglePlay();
await settle(() => player.status() === "playing", "从暂停位置继续");
assert.equal(player.focus()?.chapterIndex, 2, "继续后仍在第 2 章");
player.togglePlay();
await settle(() => player.status() === "paused", "再次暂停");
// 接管之后用户显式跳章仍要能把暂停中的朗读重锚过去。
chapter = 0;
player.noteViewChapter(false);
await settle(() => player.focus()?.chapterIndex === 0, "接管后的显式跳章正常重锚");
assert.equal(player.status(), "paused", "重锚不改变暂停状态");

// 3. 在线章节还没补齐时起播，换书后旧起播必须作废。
player.stop();
session.detachTtsReader("A");
books.get("A").chapters[0].paragraphs = [];
gateEntered = false;
releaseGate = null;
session.claimTtsBook("A");
session.attachTtsReader(binding);
session.confirmTtsReaderView();
chapter = 0;
player.start();
await settle(() => gateEntered, "等待在线章节补齐");
assert.equal(player.status(), "stopped", "补齐期间仍未起播");
// 换到 B（B 的正文已就绪），旧起播的 prepare 随后才返回。
session.claimTtsBook("B");
session.attachTtsReader({ ...binding, bookId: "B" });
session.confirmTtsReaderView();
books.get("A").chapters[0].paragraphs = ["A0。"];
releaseGate();
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(session.ttsSessionBookId(), "B");
assert.equal(player.status(), "stopped", "旧书起播不能在换书后自己响起来");
assert.equal(player.focus(), null, "旧书起播不能把焦点落在新书");
// 新书的起播照常工作。
player.start();
await settle(() => player.status() === "playing", "B 起播");
assert.equal(player.focus()?.chapterIndex, 0);
assert.equal(spoken.at(-1), "B0。", "读的是 B 的正文");
player.stop();

process.stdout.write("TTS 会话生命周期回归通过：启动构造、暂停重开与换书起播\n");
