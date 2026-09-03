/**
 * WebAudio 播放工具（替代 <audio> 标签）。
 *
 * 朗读路径：自定义源返回音频字节 → decodeAudioData 解码 → AudioBufferSourceNode
 * 播放；倍速用 node.playbackRate；暂停用 AudioContext.suspend()/resume()（可精确
 * 停在句中的某个时间点），停止/换句则 stop 当前节点。
 *
 * 只放与解码/上下文相关的薄封装，播放调度/换句逻辑留在 ttsPlayer.ts。
 */

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
  return getAudioContext().decodeAudioData(copy);
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
