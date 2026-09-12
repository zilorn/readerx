/** 本地书籍的共享类型定义 */

export type BookFormat = "txt" | "epub" | "online";

/** 书籍导入来源：webdav 导入带 "webdav" 标记；在线书为 "online"，其余视为本地导入 */
export type BookSource = "local" | "webdav" | "online";

/** 归一化书籍来源：旧数据未存 source 字段时视为本地导入 */
export function bookSourceOf(book: Pick<LocalBook, "source">): BookSource {
  if (book.source === "webdav") return "webdav";
  if (book.source === "online") return "online";
  return "local";
}

/** 在线书可用；是否曾经完整下载过（有正文缓存章节数大于 0） */
export function isOnlineBook(book: Pick<LocalBook, "source" | "bookSourceId">): boolean {
  return book.source === "online" && !!book.bookSourceId;
}

/**
 * 章节内的结构化正文块：
 * - p   ：自然段（缩进正文）
 * - h   ：副标题（章内小标题，不等同于章节名）
 * - img ：插图。src 是可直接渲染的地址（本地化后为 data URL；在线书尚未下载时是网络地址），
 *   remote 是在线书的图片原始网络地址（图片身份）：阅读时按它下载、失败按它重试、
 *   下载好的本地副本也按它对应（见 lib/chapterImages.ts）。本地 / EPUB 插图没有 remote。
 */
export type ChapterBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "img"; src: string; alt?: string; remote?: string };

export interface LocalBookChapter {
  /** 章节稳定 id，如 c0001、c0002 …（旧数据可能在载入时回填） */
  cid: string;
  title: string;
  /** 兼容字段：正文纯文本段落（新解析也会填充，便于字数等统计） */
  paragraphs: string[];
  /** 结构化正文块。TXT 或旧数据缺失时 Reader 退回 paragraphs */
  blocks?: ChapterBlock[];
  /** 在线书：书源侧章节地址（bookToc 返回的 chapterUrl） */
  url?: string;
}

/** 章节稳定 id，如 c0001、c0002 …（旧数据可能在载入时回填） */
export type ChapterHead = Pick<LocalBookChapter, "cid" | "title" | "url"> & {
  /** 章节正文镜像文本的字符数（UTF-16；仅 p/h 文本，图片不计）。书架进度/详情字数以它为口径 */
  chars: number;
};

/** 书库元数据：LocalBook 去掉正文，章节仅保留轻量头。
 *  应用启动只拉这份（readerx_book_list_meta），正文按需单本读取后再物化。 */
export type BookMeta = Omit<LocalBook, "chapters"> & { chapters: ChapterHead[] };

/**
 * 章节对象一经发布即视为不可变（正文回写一律整章换成新对象），因此可以按对象缓存派生值：
 * 在线书阅读 / 下载期间整本对象被反复替换，缓存命中让「整本字数、阅读进度累计、章节头」
 * 这类派生计算只与真正变化的章节相关，而不是每次都重扫全书正文。
 */
const mirrorCharsCache = new WeakMap<LocalBookChapter, number>();

/** 章节正文“镜像文本”字符数（UTF-16）：
 *  有结构化 blocks 时只数 p/h 文本；否则退回 paragraphs。 */
export function chapterMirrorCharsOf(chapter: LocalBookChapter): number {
  const cached = mirrorCharsCache.get(chapter);
  if (cached !== undefined) return cached;
  const blocks = chapter.blocks;
  let total = 0;
  if (blocks && blocks.length > 0) {
    for (const block of blocks) {
      if (block.kind === "p" || block.kind === "h") total += block.text?.length ?? 0;
    }
  } else {
    for (const paragraph of chapter.paragraphs) total += paragraph.length;
  }
  mirrorCharsCache.set(chapter, total);
  return total;
}

/** 章节 → 轻量头（按章节对象缓存：未变章节复用同一个头对象）。
 *  正文回写后重建整本元数据时，未变章节仍是同一引用 —— 下游既能省掉重算，
 *  也能据此判定「这次写入是否真的改变了书架可见的数据」。 */
const headCache = new WeakMap<LocalBookChapter, ChapterHead>();

export function chapterHeadOf(chapter: LocalBookChapter): ChapterHead {
  const cached = headCache.get(chapter);
  if (cached) return cached;
  const head: ChapterHead = {
    cid: chapter.cid,
    title: chapter.title,
    ...(chapter.url ? { url: chapter.url } : {}),
    chars: chapterMirrorCharsOf(chapter),
  };
  headCache.set(chapter, head);
  return head;
}

/** 整书 → 书库元数据（章节裁剪为轻量头） */
export function bookToMeta(book: LocalBook): BookMeta {
  const { chapters, ...meta } = book;
  return { ...meta, chapters: chapters.map(chapterHeadOf) };
}

/**
 * 两个书籍 / 元数据对象除 skipKey（章节列表）外的字段是否一致：
 * 逐字段浅比较，数组按内容比较。用于判断一次正文回写是否真的改变了
 * 「书架可见数据」（books.ts）或「本次渲染用得到的数据」（阅读页渲染窗口）。
 */
export function samePlainFields(a: object, b: object, skipKey: string): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const key of Object.keys(x)) {
    if (key === skipKey) continue;
    const av = x[key];
    const bv = y[key];
    if (av === bv) continue;
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length || av.some((item, i) => item !== bv[i])) return false;
      continue;
    }
    return false;
  }
  // b 上出现了 a 没有的字段（新增字段）→ 视为不一致
  return Object.keys(y).every((key) => key === skipKey || key in x);
}

/** 生成章节 cid：下标 0 → c0001 */
export function chapterCid(index: number): string {
  return `c${String(index + 1).padStart(4, "0")}`;
}

/**
 * 归一化章节 cid（幂等，仅在有缺失或重复时产生新数组）：
 * - 为缺失 cid 的章节按下标补上稳定 cid；
 * - 修复历史导入遗留的重复 cid（旧 EPUB 解析曾让每个 spine 文档都从
 *   c0001 编号）：保留首个出现的 cid，后续重复者改排为未占用的新 cid。
 *   仅改重复项，不影响已有唯一 cid 锚定的进度/书签。
 */
export function assignChapterCids(chapters: LocalBookChapter[]): LocalBookChapter[] {
  const seen = new Set<string>();
  let nextFree = 0;
  const unusedCid = (): string => {
    let cid = chapterCid(nextFree);
    while (seen.has(cid)) cid = chapterCid(++nextFree);
    return cid;
  };
  return chapters.map((chapter, index) => {
    const cid = chapter.cid || chapterCid(index);
    const uniqueCid = cid && !seen.has(cid) ? cid : unusedCid();
    seen.add(uniqueCid);
    return uniqueCid === chapter.cid ? chapter : { ...chapter, cid: uniqueCid };
  });
}

export interface LocalBook {
  id: string;
  title: string;
  author: string;
  /** 书籍简介（导入时 EPUB/在线书若带简介会自动带入，可在书籍详情页编辑） */
  intro?: string;
  format: BookFormat;
  fileName: string;
  /** 文件字节数 */
  size: number;
  importedAt: number;
  /** 程序化封面基准色相（0-360） */
  hue: number;
  /** EPUB 封面缩略图（data URL，导入时从 EPUB 提取；无封面不存） */
  cover?: string;
  /** 分章方式描述，如“中文章节标题 / 按字数分章” */
  splitDesc: string;
  chapters: LocalBookChapter[];
  /** 所属书架分组 id；未分组为空 */
  groupId?: string | null;
  /** 导入来源：WebDAV 导入为 "webdav"；本地导入或旧数据缺失时不写此字段 */
  source?: BookSource;
  /** 在线书：来源书源 id（书源删除后书籍保留，仅失去更新能力） */
  bookSourceId?: string;
  /** 在线书：书源侧全书地址（与 bookSourceId 一起构成稳定身份） */
  bookUrl?: string;
  /** 标签（书源搜索/详情返回，或用户在书籍详情页手编；本地导入与在线书通用） */
  tags?: string[];
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

/** 单本书可容纳的最大标签数与单个标签最大长度（书源返回 / 手编共用） */
export const MAX_BOOK_TAG_COUNT = 30;
export const MAX_BOOK_TAG_LENGTH = 24;

/** 归一化标签：去空白 / 去重 / 限长限数；非法输入返回空数组 */
export function normalizeBookTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (out.length >= MAX_BOOK_TAG_COUNT) break;
    if (typeof raw !== "string") continue;
    const tag = raw.trim();
    if (!tag || tag.length > MAX_BOOK_TAG_LENGTH) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
