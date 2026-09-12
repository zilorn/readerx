/**
 * 简繁转换（显示级全局偏好）。
 *
 * 语义：
 * - 三种模式：关闭（默认）/ 简 → 繁 / 繁 → 简，用户可在设置页与阅读设置面板一键切换；
 * - 只影响展示（书名、作者、简介、标签、目录、正文、书源搜索结果……），
 *   绝不改动书库原文、书源返回的数据，也不影响用户手输内容（编辑表单始终是原文）；
 * - 词典来自 opencc-js（OpenCC 的纯 JS 实现，MIT / Apache-2.0）：
 *   简 → 繁约 1.1 MB、繁 → 简约 110 KB，**按方向动态加载**——
 *   没开启该功能的用户既不下发也不解析词典，开启后也只需要等一个本地 chunk。
 *
 * 持久化走 Rust 后端 readState / writeState（WebView 不落盘）。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";
import { reportFailure } from "./errorReport";

/** 转换模式：off = 不转换；s2t = 简 → 繁；t2s = 繁 → 简 */
export type HanMode = "off" | "s2t" | "t2s";

/** 需要词典的转换方向（off 之外的两种模式） */
export type HanDirection = Exclude<HanMode, "off">;

/** 转换函数：只换字形，不换含义；未收录的字符原样保留 */
export type HanConverter = (text: string) => string;

const STORAGE_KEY = "readerx.hanConvert";

const [modeSignal, setModeSignal] = createSignal<HanMode>("off");
/** 词典就绪后自增：让已经算过的显示副本重算一遍（从原文切到转换后的文字） */
const [dictEpoch, setDictEpoch] = createSignal(0);

const converters = new Map<HanDirection, HanConverter>();
const loads = new Map<HanDirection, Promise<void>>();

let writeQueue: Promise<void> = Promise.resolve();
let initialized = false;

function normalizeMode(value: unknown): HanMode {
  return value === "s2t" || value === "t2s" ? value : "off";
}

/** 载入某方向的词典并装好转换函数（幂等；同一方向只装一次） */
function ensureConverter(direction: HanDirection): Promise<void> {
  const running = loads.get(direction);
  if (running) return running;
  const task = (async () => {
    // 两个方向各自成块：只加载用户真正选中的那一种
    const convert =
      direction === "s2t"
        ? (await import("opencc-js/cn2t")).Converter({ from: "cn", to: "t" })
        : (await import("opencc-js/t2cn")).Converter({ from: "t", to: "cn" });
    converters.set(direction, convert);
    setDictEpoch((epoch) => epoch + 1);
  })().catch((error: unknown) => {
    loads.delete(direction); // 允许用户重选时再试
    reportFailure("简繁转换词典载入失败", error);
  });
  loads.set(direction, task);
  return task;
}

/** 应用启动时载入用户偏好（幂等；失败时保持关闭并提示，不影响其它功能） */
export async function initHanConvert(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const stored = await readState<string>(STORAGE_KEY);
    const mode = normalizeMode(stored);
    if (mode === "off") return;
    setModeSignal(mode);
    void ensureConverter(mode);
  } catch (error) {
    reportFailure("简繁转换设置载入失败", error);
  }
}

/** 响应式：当前转换模式 */
export function currentHanMode(): HanMode {
  return modeSignal();
}

/** 切换转换模式并持久化；开启时后台载入所需词典 */
export function setHanMode(next: HanMode): void {
  if (next === modeSignal()) return;
  setModeSignal(next);
  writeQueue = writeQueue.then(() => writeState(STORAGE_KEY, next));
  if (next !== "off") void ensureConverter(next);
}

/**
 * 显示副本版本号：0 = 当前不转换（已关闭，或词典还没到位）。
 * 读它即订阅「模式 + 词典就绪」两个信号，派生显示副本因此能在词典到位后自动重算；
 * 非 0 值随模式变化，可直接当作派生缓存的版本号。
 */
export function hanVersion(): number {
  const mode = modeSignal();
  if (mode === "off") return 0;
  const epoch = dictEpoch();
  if (epoch === 0 || !converters.has(mode)) return 0;
  return epoch * 2 + (mode === "s2t" ? 1 : 2);
}

/** 转换一段文字；关闭或词典未就绪时原样返回 */
export function convertHanText(text: string): string {
  const mode = modeSignal();
  if (mode === "off" || !text) return text;
  void dictEpoch(); // 词典就绪后调用方需要重算
  const convert = converters.get(mode);
  return convert ? convert(text) : text;
}
