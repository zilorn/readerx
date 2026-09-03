/** 本地书籍的共享类型定义 */

export type BookFormat = "txt" | "epub";

/**
 * 章节内的结构化正文块：
 * - p   ：自然段（缩进正文）
 * - h   ：副标题（章内小标题，不等同于章节名）
 * - img ：插图（src 为可在 WebView 直接渲染的 data URL）
 */
export type ChapterBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "img"; src: string; alt?: string };

export interface LocalBookChapter {
  title: string;
  /** 兼容字段：正文纯文本段落（新解析也会填充，便于字数等统计） */
  paragraphs: string[];
  /** 结构化正文块。TXT 或旧数据缺失时 Reader 退回 paragraphs */
  blocks?: ChapterBlock[];
}

export interface LocalBook {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  fileName: string;
  /** 文件字节数 */
  size: number;
  importedAt: number;
  /** 程序化封面基准色相（0-360） */
  hue: number;
  /** 分章方式描述，如“中文章节标题 / 按字数分章” */
  splitDesc: string;
  chapters: LocalBookChapter[];
}

export function totalChars(book: Pick<LocalBook, "chapters">): number {
  return book.chapters.reduce(
    (sum, chapter) =>
      sum + chapter.paragraphs.reduce((paraSum, paragraph) => paraSum + paragraph.length, 0),
    0,
  );
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
