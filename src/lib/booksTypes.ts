/** 本地书籍的共享类型定义 */

export type BookFormat = "txt" | "epub";

/** 书籍导入来源：webdav 导入带 "webdav" 标记，其余视为本地导入 */
export type BookSource = "local" | "webdav";

/** 归一化书籍来源：旧数据未存 source 字段时视为本地导入 */
export function bookSourceOf(book: Pick<LocalBook, "source">): BookSource {
  return book.source === "webdav" ? "webdav" : "local";
}

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
  /** 章节稳定 id，如 c0001、c0002 …（旧数据可能在载入时回填） */
  cid: string;
  title: string;
  /** 兼容字段：正文纯文本段落（新解析也会填充，便于字数等统计） */
  paragraphs: string[];
  /** 结构化正文块。TXT 或旧数据缺失时 Reader 退回 paragraphs */
  blocks?: ChapterBlock[];
}

/** 生成章节 cid：下标 0 → c0001 */
export function chapterCid(index: number): string {
  return `c${String(index + 1).padStart(4, "0")}`;
}

/** 为缺失 cid 的章节补上稳定 cid（幂等，不改动已有 cid） */
export function assignChapterCids(chapters: LocalBookChapter[]): LocalBookChapter[] {
  return chapters.map((chapter, index) => {
    const cid = chapter.cid || chapterCid(index);
    return cid === chapter.cid ? chapter : { ...chapter, cid };
  });
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
  /** 所属书架分组 id；未分组为空 */
  groupId?: string | null;
  /** 导入来源：WebDAV 导入为 "webdav"；本地导入或旧数据缺失时不写此字段 */
  source?: BookSource;
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
