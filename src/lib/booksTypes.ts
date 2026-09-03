/** 本地书籍的共享类型定义 */

export type BookFormat = "txt" | "epub";

export interface LocalBookChapter {
  title: string;
  paragraphs: string[];
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
