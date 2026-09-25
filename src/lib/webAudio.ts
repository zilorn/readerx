/**
 * WebAudio 播放工具（替代 <audio> 标签）。
 *
 * 朗读路径：自定义源返回音频字节 → decodeAudioData 解码 → AudioBufferSourceNode
 * 播放；倍速用 node.playbackRate；暂停用 AudioContext.suspend()/resume()（可精确
 * 停在句中的某个时间点），停止/换句则 stop 当前节点。
 *
 * 只放与解码/上下文相关的薄封装，播放调度/换句逻辑留在 ttsPlayer.ts。
 */

import { sniffAudioFormat } from "./ttsDecodeGuide";
import { createLogger } from "./logger";

const log = createLogger("web-audio");

let context: AudioContext | null = null;

/** 全局单例上下文（应用生命周期内复用，避免每次开声重建） */
export function getAudioContext(): AudioContext {
  if (!context) {
    context = new AudioContext();
  }
  return context;
}

/** 把音频字节解码成 AudioBuffer（decodeAudioData 会转移 ArrayBuffer，先拷贝一份） */
export async function decodeAudio(bytes: Uint8Array): Promise<AudioBuffer> {
  const copy = bytes.slice().buffer as ArrayBuffer;
  try {
    return await getAudioContext().decodeAudioData(copy);
  } catch (err) {
    // 解不开的原因系统不会细说（WebView 统一抛 EncodingError）。这里补上真正有用的两条：
    // 字节到底是什么格式、多大 —— Linux 上多半是缺 GStreamer 的 MP3 解码器，
    // 光看「解码失败」无从判断是源返回错了东西，还是系统缺插件。
    // 音频内容绝不进日志，只记格式与体积；用户可见提示由调用方（ttsPlayer）负责。
    log.warn(
      "音频解码失败",
      `format=${sniffAudioFormat(bytes) ?? "未知"}`,
      `bytes=${bytes.byteLength}`,
      err,
    );
    throw err;
  }
}

/** 新建一个已连接好、设置好倍速但尚未 start 的节点（由调用方决定何时发声/换句） */
export function createSourceNode(
  buffer: AudioBuffer,
  rate: number,
): AudioBufferSourceNode {
  const ctx = getAudioContext();
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.playbackRate.value = rate;
  node.connect(ctx.destination);
  return node;
}

/** 让上下文出声（如果处于 suspended 则 resume；比如暂停后继续） */
export async function resumeAudioContext(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}

/** 暂停：suspend 整个上下文，当前句停在其时间位置，可原样续播 */
export async function pauseAudioContext(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state === "running") {
    await ctx.suspend();
  }
}

/** 安全停掉并断开一个节点（换句/停止时调用），避免触发 onended 副作用 */
export function stopSourceNode(node: AudioBufferSourceNode | null): void {
  if (!node) return;
  try {
    node.onended = null;
  } catch {
    /* ignore */
  }
  try {
    node.stop();
  } catch {
    /* 尚未 start 或已 stop */
  }
  try {
    node.disconnect();
  } catch {
    /* ignore */
  }
}

/** 会话结束兜底：确保上下文不残留 suspended（新一次播放前也会再 resume） */
export function ensureContextRunningAfterStop(): void {
  void resumeAudioContext();
}
