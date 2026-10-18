// worker 是独立运行环境；在 PDF.js 初始化前补齐 legacy 包仍依赖的 API。
import "./compat.mjs";

// 保留具名导出，供不支持 module worker 的 WebView 在主线程动态载入。
export { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
