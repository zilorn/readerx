import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { MessageChannel, Worker, workerData } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import ts from "typescript";

// 每条路径使用独立进程，避免主包的 polyfill 掩盖 worker 自身的兼容性问题。
const mode = workerData ? "thread" : process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
const built = process.argv.includes("--built");
if (!mode) {
  for (const scenario of ["modern", "legacy", "worker", "loader"]) {
    const result = spawnSync(process.execPath, [import.meta.filename, scenario, ...(built ? ["--built"] : [])], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${scenario}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  }
  process.stdout.write(`PDF ${built ? "构建产物" : "源码"}兼容性检查通过：缺失 Iterator / Promise.withResolvers / 流异步迭代、独立线程与主线程回退解析、重复导入\n`);
} else {
  // 同时复现用户设备缺失的 API，不假定 legacy 已覆盖浏览器的原生流接口。
  const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  for (const key of Object.getOwnPropertyNames(iteratorPrototype)) {
    if (key !== "constructor") delete iteratorPrototype[key];
  }
  delete globalThis.Iterator;
  delete Promise.withResolvers;
  delete Promise.try;
  delete Map.prototype.getOrInsert;
  delete Map.prototype.getOrInsertComputed;
  delete ReadableStream.prototype[Symbol.asyncIterator];
  delete ReadableStream.prototype.values;
  assert.equal(typeof globalThis.Iterator, "undefined");
  assert.equal(typeof Promise.withResolvers, "undefined");
  assert.equal(typeof ReadableStream.prototype[Symbol.asyncIterator], "undefined");

  let workerUrl = workerData?.workerUrl ?? new URL("../src/lib/pdf/pdf.worker.mjs", import.meta.url).href;
  if (built) {
    const assets = new URL("../dist/assets/", import.meta.url);
    const file = (await readdir(assets)).find((name) => /^pdf\.worker-.*\.js$/.test(name));
    assert.ok(file, "请先运行 pnpm build 生成 worker");
    workerUrl = new URL(file, assets).href;
  }

  if (mode === "modern") {
    // 保留故障复现，确认测试环境能捕捉误切回现代构建的回归。
    await assert.rejects(import("pdfjs-dist"), /Iterator is not defined/);
  } else if (mode === "legacy") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    assert.throws(() => pdfjs.getDocument({ data: new Uint8Array() }), /Promise.withResolvers is not a function/);
  } else if (mode === "worker" || mode === "thread") {
    const { WorkerMessageHandler } = await import(workerUrl);
    assert.equal(typeof WorkerMessageHandler.setup, "function");
    assert.equal(typeof globalThis.Iterator, "function");
    assert.equal(typeof Promise.withResolvers, "function");
    assert.equal(typeof Promise.try, "function");
    assert.equal(typeof Map.prototype.getOrInsertComputed, "function");
    assert.equal(typeof ReadableStream.prototype[Symbol.asyncIterator], "function");
    const deferred = Promise.withResolvers();
    deferred.resolve("ready");
    assert.equal(await deferred.promise, "ready");
    if (mode === "thread") {
      workerData.port.start();
      WorkerMessageHandler.initializeFromPort(workerData.port);
    }
  } else {
    const source = await readFile(new URL("../src/lib/pdf/pdfjs.ts", import.meta.url), "utf8");
    // Node 不执行 Vite 的资源转换：把真实加载器中的包地址解析为本地文件 URL。
    const resolved = source.replace(/import workerSrc from "[^"]+\?worker&url";/,
      `const workerSrc = ${JSON.stringify(workerUrl)};`,
    ).replace(/"((?:pdfjs-dist|core-js)[^"]*)"/g, (_, specifier) =>
      JSON.stringify(import.meta.resolve(specifier)),
    ).replace('"./compat.mjs"', JSON.stringify(new URL("../src/lib/pdf/compat.mjs", import.meta.url).href))
      .replaceAll("import.meta.url", JSON.stringify(import.meta.url));
    const { outputText } = ts.transpileModule(resolved, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    const { loadPdfJs } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
    const pending = loadPdfJs();
    assert.equal(loadPdfJs(), pending, "并发导入共用模块加载任务");
    const pdfjs = await pending;
    assert.equal(typeof Promise.withResolvers, "function");
    assert.equal(typeof ReadableStream.prototype[Symbol.asyncIterator], "function");
    assert.equal(pdfjs.GlobalWorkerOptions.workerSrc, workerUrl);

    // 有效 xref 的文字 PDF，同时覆盖普通内容流与 FlateDecode 压缩内容流。
    function pdfBytes(compressed) {
      const text = "BT /F1 12 Tf 20 100 Td (ReaderX compatibility) Tj ET\n";
      const stream = compressed ? deflateSync(Buffer.from(text)).toString("latin1") : text;
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${stream.length}${compressed ? " /Filter /FlateDecode" : ""} >>\nstream\n${stream}endstream`,
      ];
      let pdf = "%PDF-1.4\n";
      const offsets = [0];
      objects.forEach((object, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = pdf.length;
      pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
      for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
      pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return new Uint8Array(Buffer.from(pdf, "latin1"));
    }

    for (const execution of ["fallback", "thread"]) {
      const { port1, port2 } = new MessageChannel();
      const thread = execution === "thread" ? new Worker(new URL(import.meta.url), {
        workerData: { workerUrl, port: port2 },
        transferList: [port2],
      }) : null;
      // 线程内重新移除 API，证明 worker 不依赖主线程中已安装的补丁。
      const threadFailure = new Promise((_, reject) => thread?.once("error", reject));
      port1.start();
      const worker = thread ? pdfjs.PDFWorker.create({ port: port1 }) : undefined;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const task = pdfjs.getDocument({ data: pdfBytes(attempt === 1), worker, isEvalSupported: false, useSystemFonts: true });
          try {
            const doc = await Promise.race([task.promise, threadFailure]);
            assert.equal(doc.numPages, 1);
            const page = await doc.getPage(1);
            const text = await page.getTextContent();
            assert.equal(text.items.map((item) => item.str ?? "").join(""), "ReaderX compatibility");
            assert.ok((await page.getOperatorList()).fnArray.length > 0);
            page.cleanup();
            await doc.cleanup();
          } finally {
            await task.destroy();
          }
          assert.equal(await loadPdfJs(), pdfjs, "释放文档后复用模块，再次导入可正常创建 worker");
        }
      } finally {
        worker?.destroy();
        await thread?.terminate();
        port1.close();
        port2.close();
      }
    }
  }
}
