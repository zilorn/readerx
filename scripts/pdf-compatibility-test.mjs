import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import ts from "typescript";

// 每条路径使用独立进程，避免主包的 polyfill 掩盖 worker 自身的兼容性问题。
const mode = process.argv[2];
if (!mode) {
  for (const scenario of ["modern", "worker", "loader"]) {
    const result = spawnSync(process.execPath, [import.meta.filename, scenario], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${scenario}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  }
  process.stdout.write("PDF 兼容性检查通过：复现 Iterator 缺失、独立 worker 加载、主线程回退解析与重复导入\n");
} else {
  // 模拟 legacy 支持范围内、尚未实现这些新 API 的 WebView（保留 Promise.withResolvers）；
  // 同时移除迭代器原型上的原生助手方法。
  const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  for (const key of Object.getOwnPropertyNames(iteratorPrototype)) {
    if (key !== "constructor") delete iteratorPrototype[key];
  }
  delete globalThis.Iterator;
  delete Promise.try;
  delete Map.prototype.getOrInsert;
  delete Map.prototype.getOrInsertComputed;
  assert.equal(typeof globalThis.Iterator, "undefined");

  if (mode === "modern") {
    // 保留故障复现，确认测试环境能捕捉误切回现代构建的回归。
    await assert.rejects(import("pdfjs-dist"), /Iterator is not defined/);
  } else if (mode === "worker") {
    const { WorkerMessageHandler } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
    assert.equal(typeof WorkerMessageHandler.setup, "function");
    assert.equal(typeof globalThis.Iterator, "function");
    assert.equal(typeof Promise.try, "function");
    assert.equal(typeof Map.prototype.getOrInsertComputed, "function");
  } else {
    const source = await readFile(new URL("../src/lib/pdf/pdfjs.ts", import.meta.url), "utf8");
    // Node 不执行 Vite 的资源转换：把真实加载器中的包地址解析为本地文件 URL。
    const resolved = source.replace(/"(pdfjs-dist[^\"]*)"/g, (_, specifier) =>
      JSON.stringify(import.meta.resolve(specifier)),
    ).replaceAll("import.meta.url", JSON.stringify(import.meta.url));
    const { outputText } = ts.transpileModule(resolved, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    const { loadPdfJs } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
    const pending = loadPdfJs();
    assert.equal(loadPdfJs(), pending, "并发导入共用模块加载任务");
    const pdfjs = await pending;
    assert.match(pdfjs.GlobalWorkerOptions.workerSrc, /\/legacy\/build\/pdf\.worker\.min\.mjs$/);

    // 使用有效 xref 的最小文字 PDF，实际走文档加载、文字提取和绘图指令解析。
    function pdfBytes() {
      const stream = "BT /F1 12 Tf 20 100 Td (ReaderX compatibility) Tj ET\n";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
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
      return new TextEncoder().encode(pdf);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const task = pdfjs.getDocument({ data: pdfBytes(), isEvalSupported: false, useSystemFonts: true });
      try {
        const doc = await task.promise;
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
  }
}
