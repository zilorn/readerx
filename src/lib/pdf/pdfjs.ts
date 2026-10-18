/**
 * pdf.js 的加载与 worker 配置（PDF 导入的唯一入口）。
 *
 * 库本身与 worker 都很大（pdf.js 主包 + worker 共 1 MB 以上），因此：
 * - 主包与 worker 都使用 `legacy/build`，补齐旧 Android WebView 缺少的
 *   Iterator、Promise.try 等 API；只切换主包无法覆盖 worker 的独立运行环境；
 * - 主包只做成**动态 import**（`src/lib/pdf.ts` 里按需载入），不进首屏；
 * - 主线程与 pdf.worker.mjs 各自先补齐 legacy 包仍依赖的 Promise.withResolvers；
 * - worker 由 Vite 连同兼容补丁打包，地址经 `?worker&url` 交给 pdf.js
 *   （Tauri 的 WebView 里就是应用自身的地址，不依赖 CDN）；
 * - worker 起不来（Android 老 WebView 不支持 module worker 等）时 pdf.js 会自行
 *   退回主线程动态载入同一份入口，兼容补丁与具名导出都要保留。
 */

import "core-js/actual/promise/with-resolvers.js";
import workerSrc from "./pdf.worker.mjs?worker&url";

/** pdf.js 的模块形状（只声明本项目用到的部分，避免把 pdfjs-dist 的类型拖进首屏） */
export interface PdfJsModule {
  getDocument(params: {
    data: ArrayBuffer | Uint8Array;
    isEvalSupported?: boolean;
    useSystemFonts?: boolean;
    disableFontFace?: boolean;
  }): PdfLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
}

/** 一次文档加载任务：promise 给出文档，destroy 释放 worker 侧资源 */
export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  getOutline(): Promise<PdfOutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: object): Promise<number>;
  /** 释放文档在前后端占用的资源（pdf.js v6 起 destroy 只在加载任务上） */
  cleanup(keepLoadedFonts?: boolean): Promise<unknown>;
}

export interface PdfPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
  }): { promise: Promise<void> };
  getTextContent(params?: { includeMarkedContent?: boolean }): Promise<{
    items: unknown[];
  }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
  cleanup(): void;
}

export interface PdfOutlineNode {
  title: string;
  dest: unknown;
  items?: PdfOutlineNode[];
}

let workerReady = false;

/** 配置 pdf.js 的 worker 入口（幂等） */
export function configurePdfWorker(pdfjs: PdfJsModule): void {
  if (workerReady) return;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  workerReady = true;
}

let modulePromise: Promise<PdfJsModule> | null = null;

/** 载入 pdf.js（含 worker 配置）。同一会话只加载一次 */
export function loadPdfJs(): Promise<PdfJsModule> {
  if (!modulePromise) {
    modulePromise = import("pdfjs-dist/legacy/build/pdf.mjs")
      .then((mod) => {
        const pdfjs = mod as unknown as PdfJsModule;
        configurePdfWorker(pdfjs);
        return pdfjs;
      })
      .catch((err) => {
        // 加载失败不缓存失败结果：下次导入可以再试一次
        modulePromise = null;
        throw err;
      });
  }
  return modulePromise;
}
