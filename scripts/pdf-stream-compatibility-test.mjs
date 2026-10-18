import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";

const mode = process.argv[2];
if (!mode) {
  for (const scenario of ["native", "missing", "missing-symbol", "missing-values"]) {
    const result = spawnSync(process.execPath, [import.meta.filename, scenario], {
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, `${scenario}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  }
  process.stdout.write("PDF 流兼容检查通过：保留原生接口、顺序读取、结束/退出/异常释放锁、取消与 preventCancel、解压流\n");
} else {
  const original = ReadableStream;
  const nativeValues = ReadableStream.prototype.values;
  const nativeIterator = ReadableStream.prototype[Symbol.asyncIterator];
  if (mode === "missing" || mode === "missing-symbol") delete ReadableStream.prototype[Symbol.asyncIterator];
  if (mode === "missing" || mode === "missing-values") delete ReadableStream.prototype.values;
  await import("../src/lib/pdf/compat.mjs");
  assert.equal(ReadableStream, original, "不替换原生 ReadableStream，保留平台流兼容性");
  if (mode === "native" || mode === "missing-symbol") assert.equal(ReadableStream.prototype.values, nativeValues);
  if (mode === "native" || mode === "missing-values") assert.equal(ReadableStream.prototype[Symbol.asyncIterator], nativeIterator);

  function streamOf(values, cancel) {
    return new ReadableStream({
      start(controller) {
        values.forEach((value) => controller.enqueue(value));
        controller.close();
      },
      cancel,
    });
  }
  async function collect(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  }

  let cancelled = false;
  const complete = streamOf(["one", undefined, "two"], () => { cancelled = true; });
  assert.deepEqual(await collect(complete), ["one", undefined, "two"]);
  assert.equal(complete.locked, false);
  assert.equal(cancelled, false, "正常读完不再取消");

  const early = streamOf(["one", "two"], () => { cancelled = true; });
  for await (const chunk of early) { assert.equal(chunk, "one"); break; }
  assert.equal(cancelled, true, "提前退出默认取消剩余流");
  assert.equal(early.locked, false);

  const keep = streamOf(["one", "two"]);
  for await (const chunk of keep.values({ preventCancel: true })) { assert.equal(chunk, "one"); break; }
  assert.equal(keep.locked, false);
  assert.deepEqual(await collect(keep), ["two"], "preventCancel 保留未读数据");

  let controller;
  let reason;
  const queued = new ReadableStream({
    start(value) { controller = value; },
    cancel(value) { reason = value; },
  });
  const iterator = queued.values();
  assert.equal(queued.locked, true, "获取迭代器立即加锁");
  assert.throws(() => queued.getReader(), TypeError);
  const first = iterator.next();
  const second = iterator.next();
  const end = iterator.return("stop");
  controller.enqueue("one");
  controller.enqueue("two");
  assert.deepEqual(await first, { value: "one", done: false });
  assert.deepEqual(await second, { value: "two", done: false });
  assert.deepEqual(await end, { value: "stop", done: true });
  assert.equal(reason, "stop");
  assert.equal(queued.locked, false);
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });

  const beforeRead = new ReadableStream({ cancel(value) { reason = value; } });
  await beforeRead.values().return("unread");
  assert.equal(reason, "unread", "尚未开始读也要取消并解锁");
  assert.equal(beforeRead.locked, false);

  const failure = new Error("stream failure");
  const broken = new ReadableStream({ start(value) { value.error(failure); } });
  const brokenIterator = broken.values();
  await assert.rejects(brokenIterator.next(), (error) => error === failure);
  assert.equal(broken.locked, false);
  assert.deepEqual(await brokenIterator.next(), { value: undefined, done: true });

  const badCancel = new ReadableStream({ cancel() { throw failure; } });
  await assert.rejects(badCancel.values().return(), (error) => error === failure);
  assert.equal(badCancel.locked, false, "取消失败仍释放锁");

  const body = new Response("native response").body;
  assert.equal(new TextDecoder().decode((await collect(body))[0]), "native response");
  const compressed = deflateSync(Buffer.from("PDF compressed stream"));
  const decoded = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"));
  assert.equal(Buffer.concat(await collect(decoded)).toString(), "PDF compressed stream");
  assert.equal(decoded.locked, false);
}
