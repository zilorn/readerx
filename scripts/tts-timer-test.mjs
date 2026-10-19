import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as solid from "../node_modules/solid-js/dist/solid.js";

// 运行真实播放器和分句；仅替换时钟、宿主与音频设备，不等待真实分钟数。
let now = 0;
let nextHandle = 0;
const intervals = new Map();
const timeouts = new Map();
const originalNow = Date.now;
Date.now = () => now;
globalThis.window = {
  setInterval: (fn) => { intervals.set(++nextHandle, fn); return nextHandle; },
  clearInterval: (id) => intervals.delete(id),
  setTimeout: (fn) => { timeouts.set(++nextHandle, fn); return nextHandle; },
  clearTimeout: (id) => timeouts.delete(id),
};
let engine = "native";
let nativeEvent;
let audioNode;
const mocks = {
  "solid-js": solid,
  "./backend": {},
  "./ttsSettings": {
    currentTtsPageSplit: () => false, currentTtsEngine: () => engine,
    currentTtsRate: () => 1, currentTtsVoice: () => "test",
    ensureTtsPrefsLoaded: async () => {}, httpTtsConfigured: () => true,
    setTtsEngine() {}, setTtsRate() {}, setTtsVoice() {},
  },
  "./ttsEngine": {
    describeNativeError: String, ensureNativeVoiceSelected: async () => "test",
    isNativeTtsAvailable: () => true, nativeVoiceName: () => "test",
    speakNativeSentence: async () => {}, stopNativeSpeech: async () => {},
    subscribeNativeSpeechEvents: async (fn) => {
      nativeEvent = fn;
      return () => { nativeEvent = undefined; };
    },
  },
  "./httpTts": {
    httpHasRatePlaceholder: () => false, httpRequestFingerprint: () => "test",
    synthesizeHttpAudio: async () => ({ bytes: new Uint8Array([1]), mime: "audio/wav" }),
  },
  "./webAudio": {
    decodeAudio: async () => ({}), pauseAudioContext: async () => {},
    resumeAudioContext: async () => {}, stopSourceNode: () => {},
    createSourceNode: () => (audioNode = { start() {} }),
  },
  "./ttsDecodeGuide": { isLinuxDesktop: () => false },
  "./i18n": { t: (key) => key },
  "./logger": { createLogger: () => Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [level, () => {}]),
  ) },
};
const modules = new Map();
const require = createRequire(import.meta.url);
function load(name) {
  if (mocks[name]) return mocks[name];
  if (!name.startsWith("./")) return require(name);
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
const { createTtsPlayer } = load("./ttsPlayer");
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function elapse(ms) {
  now += ms;
  for (const tick of [...intervals.values()]) tick();
}
function fixture(chapterIndex = 0) {
  let view = chapterIndex;
  const notices = [];
  const navigations = [];
  const chapters = [0, 1].map((n) => ({
    cid: `chapter-${n}`, title: "", paragraphs: ["第一句。第二句。"],
  }));
  const player = createTtsPlayer({
    bookId: () => "timer-test", chapterIndex: () => view,
    chapterAt: (index) => chapters[index], chapterCount: () => chapters.length,
    readingOffset: () => 0,
    navigateChapter: (index) => { view = index; navigations.push(index); },
    notify: (key) => notices.push(key),
  });
  return { player, notices, navigations };
}
async function finishSentence() {
  if (engine === "native") nativeEvent({ type: "finish" });
  else audioNode.onended();
  await flush();
}
async function finishChapter(player) {
  const chapter = player.focus().chapterIndex;
  for (let i = 0; i < 10 && player.status() === "playing" && player.focus()?.chapterIndex === chapter; i++) {
    await finishSentence();
  }
}
function dispose(player) {
  player.dispose();
  assert.equal(intervals.size, 0, "dispose releases minute timers");
  assert.equal(timeouts.size, 0, "dispose releases native watchdogs");
}

try {
  for (engine of ["native", "http"]) {
    {
      const { player } = fixture();
      player.setTimerFinishChapter(true);
      assert.equal(player.timerMode(), "off", "toggle cannot start an implicit timer");
      assert.equal(player.timerMinutes(), 0);
      assert.equal(player.timerFinishChapter(), false);
      player.setTimer("minutes", 30);
      elapse(5_000);
      player.setTimerFinishChapter(true);
      assert.equal(player.timerMode(), "minutes");
      assert.equal(player.timerMinutes(), 30);
      assert.equal(player.timerRemainSec(), 1795, "enabling does not restart the countdown");
      player.setTimer("minutes", 10);
      assert.equal(player.timerFinishChapter(), true, "changing minutes preserves the toggle");
      assert.equal(player.timerRemainSec(), 600);
      elapse(2_000);
      player.setTimerFinishChapter(false);
      assert.equal(player.timerRemainSec(), 598, "disabling does not restart the countdown");
      for (const mode of ["off", "chapter"]) {
        player.setTimer("minutes", 20);
        player.setTimerFinishChapter(true);
        player.setTimer(mode);
        assert.equal(player.timerFinishChapter(), false);
        assert.equal(player.timerMinutes(), 0);
        assert.equal(player.timerRemainSec(), null);
        player.setTimerFinishChapter(true);
        assert.equal(player.timerFinishChapter(), false);
        player.setTimer("minutes", 60);
        assert.equal(player.timerFinishChapter(), false, "reset survives selecting minutes again");
      }
      dispose(player);
    }
    for (const chapter of [0, 1]) {
      const { player, notices, navigations } = fixture(chapter);
      player.start();
      await flush();
      assert.equal(player.status(), "playing");
      player.setTimer("minutes", 10);
      player.setTimerFinishChapter(true);
      elapse(600_000);
      assert.equal(player.timerMode(), "off");
      assert.equal(player.timerFinishChapter(), false);
      assert.equal(player.status(), "playing", "expiry lets the current chapter continue");
      assert.equal(notices.at(-1), "tts.notify.timerFinishChapter");
      await finishChapter(player);
      assert.equal(player.status(), "stopped");
      assert.equal(notices.at(-1), chapter === 1 ? "tts.notify.bookFinished" : "tts.notify.timerChapterEnd");
      assert.deepEqual(navigations, [], "no next chapter after timed finish");
      dispose(player);
    }
    {
      const { player, notices } = fixture();
      player.start();
      await flush();
      player.setTimer("minutes", 10);
      player.setTimerFinishChapter(true);
      elapse(5_000);
      player.stop();
      elapse(600_000);
      assert.equal(player.timerRemainSec(), 595);
      assert.equal(player.timerFinishChapter(), true, "stop preserves the configured toggle");
      player.startFromChar(0);
      await flush();
      elapse(594_000);
      assert.equal(player.timerRemainSec(), 1);
      player.togglePlay();
      elapse(1_000);
      assert.equal(player.status(), "paused", "expiry while paused keeps playback paused");
      player.togglePlay();
      await flush();
      await finishChapter(player);
      assert.equal(player.status(), "stopped");
      assert.equal(notices.at(-1), "tts.notify.timerChapterEnd");
      dispose(player);
    }
    {
      const { player, notices } = fixture();
      player.start();
      await flush();
      player.setTimer("minutes", 10);
      elapse(600_000);
      assert.equal(player.status(), "stopped", "plain minute timer stops immediately");
      assert.equal(notices.at(-1), "tts.notify.timerEnd");
      dispose(player);
    }
    {
      const { player, notices } = fixture();
      player.start();
      await flush();
      player.setTimer("minutes", 10);
      player.setTimerFinishChapter(true);
      player.setTimer("chapter");
      await finishChapter(player);
      assert.equal(player.status(), "stopped");
      assert.equal(notices.at(-1), "tts.notify.chapterTimerEnd");
      dispose(player);
    }
    console.log(`TTS timer regression passed (${engine})`);
  }
} finally {
  Date.now = originalNow;
}
