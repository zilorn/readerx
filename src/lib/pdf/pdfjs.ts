/**
 * pdf.js 的加载与 worker 配置（PDF 导入的唯一入口）。
 *
 * 库本身与 worker 都很大（pdf.js 主包 + worker 共 1 MB 以上），因此：
 * - `pdfjs-dist` 只做成**动态 import**（`src/lib/pdf.ts` 里按需载入），不进首屏；
 * - worker 由 Vite 打包成独立 chunk，地址经 `new URL(..., import.meta.url)` 交给
 *   pdf.js（Tauri 的 WebView 里就是应用自身的地址，不依赖 CDN）；
 * - worker 起不来（Android 老 WebView 不支持 module worker 等）时 pdf.js 会自行
 *   退回主线程执行同一份 worker 代码，功能不受影响，因此这里不额外兜底。
 */

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

/** 配置 pdf.js 的 worker 地址（幂等；每个 PDF 文档共用一个 worker 池） */
export function configurePdfWorker(pdfjs: PdfJsModule): void {
  if (workerReady) return;
  workerReady = true;
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
  } catch {
    // 打包器没能解析出 worker 资源：pdf.js 会退回主线程，宁可慢也不要打不开
  }
}

let modulePromise: Promise<PdfJsModule> | null = null;

/** 载入 pdf.js（含 worker 配置）。同一会话只加载一次 */
export function loadPdfJs(): Promise<PdfJsModule> {
  if (!modulePromise) {
    modulePromise = import("pdfjs-dist")
      .then((mod) => {
        const pdfjs = (mod.default ?? mod) as unknown as PdfJsModule;
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
