/** PDF.js 两端共用的兼容入口；必须在主包 / worker 初始化前执行。 */
import "core-js/actual/promise/with-resolvers.js";

// 部分 WebView 有原生 ReadableStream/getReader，却尚不支持 for-await。
// 保留原生流（包括 DecompressionStream 生成的流），只补缺失的迭代接口。
// 锁、取消与 preventCancel 语义：https://streams.spec.whatwg.org/#rs-asynciterator
function streamValues(options = {}) {
  const preventCancel = Boolean(options?.preventCancel);
  const reader = this.getReader();
  let finished = false;
  let pending = Promise.resolve();

  // next/return 必须串行，提前退出不能越过尚未完成的 read 释放锁。
  function enqueue(action) {
    const result = pending.then(action);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    next() {
      return enqueue(async () => {
        if (finished) return { value: undefined, done: true };
        try {
          const result = await reader.read();
          if (result.done) {
            finished = true;
            reader.releaseLock();
          }
          return result;
        } catch (error) {
          finished = true;
          reader.releaseLock();
          throw error;
        }
      });
    },
    return(value) {
      return enqueue(async () => {
        if (!finished) {
          finished = true;
          try {
            if (!preventCancel) await reader.cancel(value);
          } finally {
            reader.releaseLock();
          }
        }
        return { value, done: true };
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

const prototype = globalThis.ReadableStream?.prototype;
if (prototype) {
  const values = typeof prototype.values === "function" ? prototype.values
    : typeof prototype[Symbol.asyncIterator] === "function" ? prototype[Symbol.asyncIterator]
    : streamValues;
  for (const key of ["values", Symbol.asyncIterator]) {
    if (typeof prototype[key] !== "function") {
      Object.defineProperty(prototype, key, { value: values, writable: true, configurable: true });
    }
  }
}
