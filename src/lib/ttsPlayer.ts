/**
 * 听书播放控制器（原生 TTS / 自定义 HTTP 源 双引擎，HTTP 源走 WebAudio）。
 *
 * 职责：
 * - 以「章节镜像偏移」为单位维护当前朗读句（与书签/正文高亮同一套坐标）；
 * - 原生引擎（native）：句子逐句交给系统 TTS，靠 speech:finish 事件切下一句；
 *   暂停 = 停止当前句，继续时从当前句开头重读（系统 TTS 无暂停 API）；
 * - 自定义 HTTP 源（http）：把句子发到用户配置的接口拿音频字节，用 WebAudio
 *   decodeAudioData + AudioBufferSourceNode 播放（无 <audio> 标签）；暂停用
 *   AudioContext.suspend/resume 可精确停在句中位置；倍速用 playbackRate；
 * - 上一句/下一句、暂停/继续、倍速/音色即时生效（重读当前句）；
 *   章节播完自动切下一章（读完整本书），定时（分钟 / 本章结束）自动停止；
 * - 预热：HTTP 引擎下，阅读页空闲会预热当前章节窗口；也可 warmBook 批量把
 *   整本书逐句合成进按书籍的磁盘缓存（同书同声源下次直接命中，不再请求）。
 * - 视图章节由外部（阅读页）驱动：外部翻章时调用 noteViewChapter() 跟随。
 *
 * 实例与阅读页同生命周期；dispose() 负责清理监听、计时器与 WebAudio 节点。
 */
import { createSignal } from "solid-js";
import type { LocalBookChapter } from "./booksTypes";
import {
  currentTtsEngine,
  currentTtsRate,
  currentTtsVoice,
  ensureTtsPrefsLoaded,
  httpTtsConfigured,
  setTtsEngine as persistEngine,
  setTtsRate as persistRate,
  setTtsVoice as persistVoice,
  type TtsEngine,
} from "./ttsSettings";
import {
  describeNativeError,
  ensureNativeVoiceSelected,
  isNativeTtsAvailable,
  nativeVoiceName,
  speakNativeSentence,
  stopNativeSpeech,
  subscribeNativeSpeechEvents,
} from "./ttsEngine";
import {
  httpHasRatePlaceholder,
  httpRequestFingerprint,
  synthesizeHttpAudio,
} from "./httpTts";
import {
  createSourceNode,
  decodeAudio,
  pauseAudioContext,
  resumeAudioContext,
  stopSourceNode,
} from "./webAudio";
import { buildChapterSpeechItems, type ChapterSpeechItem } from "./ttsSegment";

export type TtsStatus = "stopped" | "loading" | "playing" | "paused" | "error";
export type TtsTimerMode = "off" | "minutes" | "chapter";

/** 当前正在朗读的位置信息（供高亮/悬浮球展示） */
export interface TtsFocus {
  chapterIndex: number;
  cid: string;
  chapterTitle: string;
  index: number;
  total: number;
  item: ChapterSpeechItem;
}

export interface TtsPlayerCtx {
  /** 当前书籍 id（用于按书籍持久化音频缓存） */
  bookId: () => string;
  /** 视图所在章节（阅读页当前章节） */
  chapterIndex: () => number;
  /** 取某章数据 */
  chapterAt: (index: number) => LocalBookChapter | undefined;
  chapterCount: () => number;
  /** 让阅读页切章 */
  navigateChapter: (index: number) => void;
  /** 当前阅读位置（镜像偏移）；未知返回 null */
  readingOffset: () => number | null;
  /** 轻提示 */
  notify?: (message: string, isError?: boolean) => void;
}

/** 一次朗读会话的可用状态 */
export interface TtsPlayer {
  status: () => TtsStatus;
  focus: () => TtsFocus | null;
  timerMode: () => TtsTimerMode;
  timerMinutes: () => number;
  timerRemainSec: () => number | null;
  engine: () => TtsEngine;
  rate: () => number;
  voice: () => string;
  /** 悬浮球等处展示的“引擎/音色”短文案 */
  voiceName: () => string;
  error: () => string | null;
  start: () => void;
  stop: () => void;
  togglePlay: () => void;
  prev: () => void;
  next: () => void;
  setRate: (rate: number) => void;
  setVoice: (voiceId: string) => void;
  setEngine: (engine: TtsEngine) => void;
  setTimer: (mode: TtsTimerMode, minutes?: number) => void;
  /** 视图章节变化时调用（阅读页 createEffect(chapterIdx)） */
  noteViewChapter: () => void;
  /** 停止状态下预热当前章节窗口（HTTP 源写盘缓存） */
  warmup: () => void;
  /**
   * 批量预热整本书（HTTP 源）：逐句合成写进按书籍的缓存。
   * 播放开始即中止；进度经回调上报。返回处理成功的句数（可能少于总数）。
   */
  warmBook: (onProgress?: (done: number, total: number) => void) => Promise<number>;
  dispose: () => void;
}

/** HTTP 源播放预取超前句数（播放中提前合成） */
const PREFETCH_DIST = 9;
/** 批量预热并发数（用户口径：激进、不限速） */
const WARM_CONCURRENCY = 8;

interface ActiveSource {
  node: AudioBufferSourceNode;
  my: number;
}

export function createTtsPlayer(ctx: TtsPlayerCtx): TtsPlayer {
  const [status, setStatus] = createSignal<TtsStatus>("stopped");
  const [focus, setFocus] = createSignal<TtsFocus | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [timerMode, setTimerMode] = createSignal<TtsTimerMode>("off");
  const [timerMinutes, setTimerMinutes] = createSignal<number>(0);
  const [timerRemainSec, setTimerRemainSec] = createSignal<number | null>(null);

  // ---- 内部可变状态（不走响应式） ----
  let seq = 0;
  let items: ChapterSpeechItem[] = [];
  let chapterIdxEngine = ctx.chapterIndex();
  let pendingAutoNav = -1;
  let autoStartPref: "first" | "last" = "first";
  let pausedRequested = false;
  let timerHandle: number | undefined;
  let timerDeadline = 0;
  let disposed = false;
  let starting = false;
  // ---- 原生引擎（native）状态 ----
  /** 正在等当前句的 speech:finish / speech:error（等待期间不响应其它事件） */
  let nativeWaiting = false;
  /** 防卡死看门狗：引擎漏发结束事件时也能继续往下读 */
  let watchdogHandle: number | undefined;
  let listenersReady = false;
  let unlistenEvents: (() => void) | undefined;
  // ---- HTTP 源（WebAudio）状态 ----
  let activeSource: ActiveSource | null = null;
  /** 已取回的音频字节（一句一份，切章/停止时清空） */
  let audioBytesCache = new Map<string, { mime: string; bytes: Uint8Array }>();
  /** 最近一次失败的真实原因（供 UI 透出，便于无日志环境排查） */
  let lastSynthError: string | null = null;

  const isNativeMode = (): boolean => currentTtsEngine() === "native";
  const bump = (): number => ++seq;

  // ------------------------------------------------------------------
  // 原生引擎辅助
  // ------------------------------------------------------------------

  /** 结束对当前句结束事件的等待（事件与看门狗都清理） */
  function clearNativeWait(): void {
    nativeWaiting = false;
    if (watchdogHandle !== undefined) {
      window.clearTimeout(watchdogHandle);
      watchdogHandle = undefined;
    }
  }

  async function ensureNativeListeners(): Promise<boolean> {
    if (listenersReady) return true;
    try {
      unlistenEvents = await subscribeNativeSpeechEvents((ev) => {
        if (disposed) return;
        if (ev.type === "finish") {
          if (!nativeWaiting) return;
          clearNativeWait();
          advanceFromCurrent();
          return;
        }
        if (ev.type === "error") {
          if (!nativeWaiting) return;
          clearNativeWait();
          const msg = ev.error ? `语音朗读出错：${ev.error}` : "系统语音出错，请稍后重试";
          reportError(msg);
        }
        // cancel / interrupted / backgroundPause / start：不打断逐句流程，
        // 引擎自行停掉的情况由看门狗兜底，避免整本书卡死。
      });
      listenersReady = true;
      return true;
    } catch {
      return false;
    }
  }

  /** 读完超时兜底：按句长估算 + 裕量，仍无结束事件则当作读完继续 */
  function armWatchdog(text: string): void {
    const rate = Math.max(0.25, currentTtsRate());
    const dur = Math.min(180_000, Math.max(6_000, (text.length / 3 / rate) * 1000 + 4_000));
    watchdogHandle = window.setTimeout(() => {
      watchdogHandle = undefined;
      if (disposed || !nativeWaiting) return;
      clearNativeWait();
      advanceFromCurrent();
    }, dur);
  }

  // ------------------------------------------------------------------
  // HTTP 源（WebAudio）辅助
  // ------------------------------------------------------------------

  /** 缓存键：含接口配置（声明了 {$RATE} 时含倍速），源/配置变化后自然失效 */
  function httpCacheKey(item: ChapterSpeechItem): string {
    return `${item.unit}#${item.ls}#${item.le}#${httpRequestFingerprint()}`;
  }

  /** 停掉当前 WebAudio 节点（停止/换句前调用） */
  function stopActiveSource(): void {
    if (activeSource) {
      stopSourceNode(activeSource.node);
      activeSource = null;
    }
  }

  async function ensureAudioBytes(
    item: ChapterSpeechItem,
    my: number,
  ): Promise<{ mime: string; bytes: Uint8Array } | null> {
    const key = httpCacheKey(item);
    const hit = audioBytesCache.get(key);
    if (hit) return hit;
    let audio: { mime: string; bytes: Uint8Array } | null = null;
    try {
      audio = await synthesizeHttpAudio(item.text, ctx.bookId());
    } catch (err) {
      lastSynthError = err instanceof Error ? err.message : String(err);
    }
    if (audio === null) return null;
    // 任务未被取代、接口配置未变时写入会话内存缓存
    if (my === seq || my === 0) {
      if (httpCacheKey(item) === key) {
        audioBytesCache.set(key, audio);
      }
    }
    return audio;
  }

  // ------------------------------------------------------------------
  // 公共朗读流程
  // ------------------------------------------------------------------

  function loadItems(chapterIndex: number): void {
    chapterIdxEngine = chapterIndex;
    const ch = ctx.chapterAt(chapterIndex);
    items = ch ? buildChapterSpeechItems(ch) : [];
    audioBytesCache.clear();
  }

  function nearestIndexFor(offset: number | null): number {
    if (offset === null || offset === undefined || offset <= 0) return 0;
    for (let k = 0; k < items.length; k++) {
      if (items[k].end > offset) return k;
    }
    return Math.max(0, items.length - 1);
  }

  /** 从 from 起沿 dir（1/-1）找第一个有可读句子的章节；找不到返回 -1 */
  function contentChapter(from: number, dir: 1 | -1): number {
    let i = from;
    while (i >= 0 && i < ctx.chapterCount()) {
      const ch = ctx.chapterAt(i);
      if (ch && buildChapterSpeechItems(ch).length > 0) return i;
      i += dir;
    }
    return -1;
  }

  function activate(idxItem: number): void {
    const ch = ctx.chapterAt(chapterIdxEngine);
    const item = items[idxItem];
    if (!ch || !item) return;
    setFocus({
      chapterIndex: chapterIdxEngine,
      cid: ch.cid,
      chapterTitle: ch.title,
      index: idxItem,
      total: items.length,
      item,
    });
  }

  function reportError(msg: string): void {
    pausedRequested = false;
    clearNativeWait();
    stopActiveSource();
    void resumeAudioContext().catch(() => {});
    setStatus("error");
    setError(msg);
    ctx.notify?.(msg, true);
  }

  /** 当前句读完 → 下一句 / 下一章 / 定时结束 / 全书完 */
  function advanceFromCurrent(): void {
    const f = focus();
    if (!f) return;
    if (f.index + 1 < items.length) {
      void playFrom(f.index + 1);
      return;
    }
    // 当前章播完
    if (timerMode() === "chapter") {
      setTimerMode("off");
      setTimerRemainSec(null);
      ctx.notify?.("定时：本章朗读结束");
      stop();
      return;
    }
    if (chapterIdxEngine + 1 >= ctx.chapterCount()) {
      ctx.notify?.("本书已朗读完毕");
      stop();
      return;
    }
    const target = contentChapter(chapterIdxEngine + 1, 1);
    if (target < 0) {
      ctx.notify?.("本书已朗读完毕");
      stop();
      return;
    }
    jumpChapter(target, "first");
  }

  /** 逐句播放入口：按当前引擎分发到原生 / HTTP 两种路径 */
  async function playFrom(idxItem: number, stayPaused = false): Promise<void> {
    if (disposed) return;
    const my = bump();
    pausedRequested = stayPaused;
    clearNativeWait();
    lastSynthError = null;
    if (idxItem < 0 || idxItem >= items.length) return;
    activate(idxItem);
    setError(null);
    if (stayPaused) {
      // 暂停状态下翻章/切设置只更新高亮与焦点，不真正出声
      setStatus("paused");
      return;
    }
    if (isNativeMode()) {
      await nativePlayFrom(my);
    } else {
      await httpPlayFrom(my);
    }
  }

  /** 原生引擎：loading(接入) → playing，等 speech:finish 切下一句 */
  async function nativePlayFrom(my: number): Promise<void> {
    const item = items[focus()?.index ?? -1];
    if (!item) return;
    if (!isNativeTtsAvailable()) {
      reportError("原生语音需在 Tauri 应用内运行（Android 真机），当前环境不可用");
      return;
    }
    setStatus("loading");
    if (!(await ensureNativeListeners())) {
      reportError("系统语音插件不可用，请确认已在安卓设备上运行");
      return;
    }
    if (disposed || my !== seq) return;
    let voice: string;
    try {
      voice = await ensureNativeVoiceSelected();
    } catch {
      voice = currentTtsVoice(); // 拉取语音失败时沿用当前值，交给引擎兜底
    }
    if (disposed || my !== seq) return;
    const ch = ctx.chapterAt(chapterIdxEngine);
    const cur = focus();
    if (!ch || !cur || cur.cid !== ch.cid) return;
    try {
      await speakNativeSentence(item.text, voice, currentTtsRate());
    } catch (err) {
      reportError(describeNativeError(err));
      return;
    }
    if (disposed || my !== seq) return;
    if (pausedRequested) {
      setStatus("paused");
      return;
    }
    nativeWaiting = true;
    setStatus("playing");
    armWatchdog(item.text);
  }

  /** HTTP 源：loading(请求/解码) → playing（WebAudio 播完触发 onended 切下一句） */
  async function httpPlayFrom(my: number): Promise<void> {
    const item = items[focus()?.index ?? -1];
    if (!item) return;
    setStatus("loading");
    const audio = await ensureAudioBytes(item, my);
    if (disposed || my !== seq) return;
    if (!audio) {
      reportError(lastSynthError ?? "语音合成失败，请检查自定义源配置与网络");
      return;
    }
    if (pausedRequested) {
      setStatus("paused");
      return;
    }
    let buffer: AudioBuffer;
    try {
      buffer = await decodeAudio(audio.bytes);
    } catch {
      reportError("音频解码失败：自定义源需返回可解码的音频（mp3 / wav / ogg）");
      return;
    }
    if (disposed || my !== seq) return;
    if (pausedRequested) {
      setStatus("paused");
      return;
    }
    const ch = ctx.chapterAt(chapterIdxEngine);
    const cur = focus();
    if (!ch || !cur || cur.cid !== ch.cid) return;
    // 变速不变调交给服务端：地址/body 用了 {$RATE} 时音频已按倍速合成，
    // 客户端原速播放；未声明 {$RATE} 则退回客户端变速（会有轻微变调）
    const rate = currentTtsRate();
    const playRate = httpHasRatePlaceholder() ? 1 : rate;
    if (disposed || my !== seq) return;
    stopActiveSource();
    await resumeAudioContext().catch(() => {});
    if (disposed || my !== seq) return;
    const node = createSourceNode(buffer, playRate);
    activeSource = { node, my };
    node.onended = () => {
      if (activeSource?.node === node && activeSource.my === my && my === seq) {
        activeSource = null;
        advanceFromCurrent();
      }
    };
    try {
      node.start();
    } catch {
      stopActiveSource();
      reportError("音频播放失败");
      return;
    }
    setStatus("playing");
    prefetchAhead(my);
  }

  /** 为后续句子预取音频（限超前句数，分批并发，避免一次性压垮服务端） */
  async function prefetchAhead(my: number): Promise<void> {
    const limit = Math.min(items.length, (focus()?.index ?? 0) + 1 + PREFETCH_DIST);
    let k = (focus()?.index ?? 0) + 1;
    while (!disposed && k < limit && my === seq && status() === "playing") {
      const batch: Promise<unknown>[] = [];
      for (let n = 0; n < 3 && k < limit && my === seq; n++, k++) {
        batch.push(ensureAudioBytes(items[k], 0).catch(() => null));
      }
      if (batch.length > 0) await Promise.all(batch);
    }
  }

  /** 跨章跳转（引擎主动切章）。落章后由 noteViewChapter() 续播 */
  function jumpChapter(target: number, pref: "first" | "last"): void {
    if (target < 0 || target >= ctx.chapterCount() || target === ctx.chapterIndex()) return;
    pendingAutoNav = target;
    autoStartPref = pref;
    void bump();
    pausedRequested = false;
    clearNativeWait();
    stopActiveSource();
    void stopNativeSpeech();
    ctx.navigateChapter(target);
    // 立即同步（阅读页的 chapterIdx 已更新；重复调用会被幂等拦截）
    noteViewChapter();
  }

  /** 视图章节变化：引擎跟随。自动跨章继续播放；手动翻章则从阅读位置续播 */
  function noteViewChapter(): void {
    if (disposed || status() === "stopped") return;
    const vi = ctx.chapterIndex();
    const auto = pendingAutoNav === vi;
    if (auto) {
      pendingAutoNav = -1;
    }
    if (vi === chapterIdxEngine && items.length > 0) return; // 视图未变
    // 先停掉旧章节仍在读的句子，避免新章开始前的空窗继续出声
    if (nativeWaiting || status() === "playing" || status() === "loading") {
      clearNativeWait();
      stopActiveSource();
      void resumeAudioContext().catch(() => {});
      void stopNativeSpeech();
    }
    loadItems(vi);
    if (items.length === 0) {
      const target = contentChapter(vi, 1);
      if (target > vi) {
        jumpChapter(target, "first");
      } else {
        const ch = ctx.chapterAt(vi);
        ctx.notify?.(
          auto
            ? "后面的章节没有可朗读的文字"
            : ch
              ? `「${ch.title}」没有可朗读的文字`
              : "本章没有可朗读的文字",
          true,
        );
        stop();
      }
      return;
    }
    const stayPaused = status() === "paused";
    const idx = auto
      ? autoStartPref === "last"
        ? items.length - 1
        : 0
      : nearestIndexFor(ctx.readingOffset?.() ?? null);
    void playFrom(idx, stayPaused);
  }

  /** 从头（阅读位置附近）开始 / 状态为 error 时重新开始 */
  function startFromView(): void {
    if (disposed) return;
    if (status() !== "stopped") return;
    const vi = ctx.chapterIndex();
    if (!ctx.chapterAt(vi)) return;
    if (starting) return;
    starting = true;
    void ensureTtsPrefsLoaded().then(() => {
      starting = false;
      if (disposed || status() !== "stopped") return;
      loadItems(vi);
      if (items.length === 0) {
        const target = contentChapter(vi, 1);
        if (target > vi) {
          pendingAutoNav = target;
          autoStartPref = "first";
          ctx.navigateChapter(target);
          noteViewChapter();
        } else {
          ctx.notify?.("本章没有可朗读的文字", true);
        }
        return;
      }
      const idx = nearestIndexFor(ctx.readingOffset?.() ?? null);
      pausedRequested = false;
      void playFrom(idx);
    });
  }

  function stop(): void {
    if (disposed) return;
    void bump();
    pausedRequested = false;
    clearNativeWait();
    stopActiveSource();
    void resumeAudioContext().catch(() => {});
    void stopNativeSpeech();
    audioBytesCache.clear();
    items = [];
    chapterIdxEngine = ctx.chapterIndex();
    pendingAutoNav = -1;
    clearTimerHandle();
    if (timerMode() !== "off") {
      setTimerMode("off");
      setTimerMinutes(0);
      setTimerRemainSec(null);
    }
    setFocus(null);
    setError(null);
    setStatus("stopped");
  }

  function togglePlay(): void {
    if (status() === "stopped") {
      startFromView();
      return;
    }
    if (status() === "paused" || status() === "error") {
      const f = focus();
      if (!f) {
        startFromView();
        return;
      }
      if (status() === "paused" && !isNativeMode() && activeSource) {
        // HTTP 源：WebAudio suspend 暂停，可直接从句中位置续播
        pausedRequested = false;
        setError(null);
        void resumeAudioContext()
          .then(() => setStatus("playing"))
          .catch(() => setStatus("paused"));
        return;
      }
      // 原生引擎（无暂停）或暂停发生在解码前：从当前句开头重读
      setError(null);
      void playFrom(f.index);
      return;
    }
    // playing / loading → 暂停
    pausedRequested = true;
    if (isNativeMode()) {
      void bump(); // 旧句的结束事件一律作废，避免暂停后误切句
      clearNativeWait();
      void stopNativeSpeech();
    } else {
      void pauseAudioContext();
    }
    setStatus("paused");
  }

  function prev(): void {
    if (status() === "stopped") return;
    const f = focus();
    if (!f) return;
    const ni = f.index - 1;
    if (ni >= 0) {
      void playFrom(ni);
      return;
    }
    if (chapterIdxEngine <= 0) {
      void playFrom(0); // 已在全书开头：重播第一句
      return;
    }
    const target = contentChapter(chapterIdxEngine - 1, -1);
    if (target < 0) {
      void playFrom(0);
      return;
    }
    jumpChapter(target, "last");
  }

  function next(): void {
    if (status() === "stopped") return;
    const f = focus();
    if (!f) return;
    const ni = f.index + 1;
    if (ni < items.length) {
      void playFrom(ni);
      return;
    }
    if (chapterIdxEngine + 1 >= ctx.chapterCount()) return; // 已在书末
    const target = contentChapter(chapterIdxEngine + 1, 1);
    if (target < 0) return;
    jumpChapter(target, "first");
  }

  /** 设置变更（引擎/倍速/音色/接口配置变化由缓存键失效覆盖）：重读当前句 */
  function applySettingChange(): void {
    if (disposed || status() === "stopped") return;
    const stayPaused = status() === "paused";
    void bump(); // 让正在进行的旧朗读作废
    pausedRequested = stayPaused;
    clearNativeWait();
    stopActiveSource();
    void resumeAudioContext().catch(() => {});
    void stopNativeSpeech();
    setError(null);
    const f = focus();
    if (!f) return;
    void playFrom(f.index, stayPaused);
  }

  function setRate(rate: number): void {
    if (rate === currentTtsRate()) return;
    persistRate(rate);
    applySettingChange();
  }

  function setVoice(voiceId: string): void {
    if (voiceId === currentTtsVoice()) return;
    persistVoice(voiceId);
    applySettingChange();
  }

  function setEngine(engine: TtsEngine): void {
    if (engine === currentTtsEngine()) return;
    persistEngine(engine);
    audioBytesCache.clear(); // http 接口产物只属于 http 引擎
    applySettingChange();
  }

  function clearTimerHandle(): void {
    if (timerHandle !== undefined) {
      window.clearInterval(timerHandle);
      timerHandle = undefined;
    }
  }

  function setTimer(mode: TtsTimerMode, minutes = 0): void {
    clearTimerHandle();
    setTimerMode(mode);
    setTimerMinutes(minutes);
    if (mode === "minutes" && minutes > 0) {
      timerDeadline = Date.now() + minutes * 60_000;
      const tick = (): void => {
        const sec = Math.max(0, Math.round((timerDeadline - Date.now()) / 1000));
        setTimerRemainSec(sec);
        if (sec <= 0) {
          clearTimerHandle();
          setTimerMode("off");
          setTimerMinutes(0);
          setTimerRemainSec(null);
          ctx.notify?.("定时结束，已停止朗读");
          stop();
        }
      };
      tick();
      timerHandle = window.setInterval(tick, 1000);
    } else {
      setTimerRemainSec(null);
    }
  }

  // ------------------------------------------------------------------
  // 预热
  // ------------------------------------------------------------------

  /** 预热当前章节窗口：停止状态下把阅读位置往后的若干句合成为音频并写进缓存 */
  function warmup(): void {
    if (disposed || status() !== "stopped") return;
    if (currentTtsEngine() !== "http" || !httpTtsConfigured()) return;
    const vi = ctx.chapterIndex();
    if (!ctx.chapterAt(vi)) return;
    loadItems(vi);
    if (items.length === 0) return;
    const start = nearestIndexFor(ctx.readingOffset?.() ?? null);
    const end = Math.min(items.length, start + 14);
    let k = start;
    void (async () => {
      while (!disposed && k < end && status() === "stopped") {
        const group: Promise<unknown>[] = [];
        for (let n = 0; n < 3 && k < end && status() === "stopped"; n++, k++) {
          group.push(ensureAudioBytes(items[k], 0).catch(() => null));
        }
        if (group.length > 0) await Promise.all(group);
      }
    })();
  }

  /**
   * 批量预热整本书：从第 0 章到最后一章逐句合成写进按书籍的缓存。
   * 仅 HTTP 源可用；一旦开始播放立即中止。返回成功处理（含命中缓存）的句数。
   */
  async function warmBook(onProgress?: (done: number, total: number) => void): Promise<number> {
    if (disposed || currentTtsEngine() !== "http" || !httpTtsConfigured()) return 0;
    const bookId = ctx.bookId();
    const chapterCount = ctx.chapterCount();
    // 预扫描总句数（同时校验无内容章节的边界）
    let total = 0;
    const plan: string[] = [];
    for (let ci = 0; ci < chapterCount; ci++) {
      const ch = ctx.chapterAt(ci);
      if (!ch) continue;
      const itemsIn = buildChapterSpeechItems(ch);
      for (const s of itemsIn) {
        if (s.text.trim()) {
          plan.push(s.text);
        }
      }
    }
    total = plan.length;
    if (total === 0) return 0;
    onProgress?.(0, total);

    let done = 0;
    const CHUNK = WARM_CONCURRENCY;
    const queue = [...plan];
    // 一个句子一把：synthesizeHttpAudio 内部先查磁盘缓存，命中即瞬间返回
    const worker = async (): Promise<void> => {
      while (!disposed && queue.length > 0 && status() === "stopped") {
        const text = queue.shift();
        if (text === undefined) return;
        try {
          await synthesizeHttpAudio(text, bookId);
        } catch {
          /* 单句失败不中断整本预热 */
        }
        done += 1;
        onProgress?.(done, total);
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CHUNK && status() === "stopped"; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return done;
  }

  function dispose(): void {
    disposed = true;
    clearTimerHandle();
    clearNativeWait();
    stopActiveSource();
    void resumeAudioContext().catch(() => {});
    void stopNativeSpeech();
    audioBytesCache.clear();
    unlistenEvents?.();
    unlistenEvents = undefined;
  }

  function voiceNameForEngine(): string {
    if (isNativeMode()) {
      return nativeVoiceName(currentTtsVoice());
    }
    return "自定义源";
  }

  return {
    status,
    focus,
    timerMode,
    timerMinutes,
    timerRemainSec,
    engine: currentTtsEngine,
    rate: currentTtsRate,
    voice: currentTtsVoice,
    voiceName: voiceNameForEngine,
    error,
    start: startFromView,
    stop,
    togglePlay,
    prev,
    next,
    setRate,
    setVoice,
    setEngine,
    setTimer,
    noteViewChapter,
    warmup,
    warmBook,
    dispose,
  };
}
