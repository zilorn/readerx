/**
 * 简繁转换的「显示副本」层：与文本替换（lib/textReplacements.ts）同层，
 * 只产出展示用的副本，绝不改动书库原文与书源数据。
 *
 * 缓存约定：
 * - 短文本（书名 / 作者 / 简介 / 章节名 / 标签）按「词典版本 + 原文」缓存，
 *   同一段文字在书架、详情、目录之间反复求值只转换一次；
 * - 书籍 / 章节对象一经发布即视为不可变，章节副本按对象身份 + 词典版本缓存，
 *   在线书逐批回写时未变章节直接复用同一个副本，不重跑转换；
 * - **章节正文是惰性的**：副本只在真正读取 `title` / `paragraphs` / `blocks` 时
 *   才转换该字段，因此打开一本书、翻目录都不会把整本正文先转一遍。
 */
import { convertHanText, hanVersion } from "./hanConvert";
import type { ChapterBlock, LocalBook, LocalBookChapter } from "./booksTypes";

/** 短文本缓存上限：超过整表清空（书名/章节名这类字符串转换本身很便宜） */
const TEXT_CACHE_MAX = 5000;

const textCache = new Map<string, string>();
let textCacheVersion = -1;

/** 单条文本的显示副本（未开启转换或词典未就绪时原样返回） */
export function hanText(text: string): string {
  const version = hanVersion();
  if (version === 0 || !text) return text;
  if (version !== textCacheVersion) {
    textCache.clear();
    textCacheVersion = version;
  }
  const cached = textCache.get(text);
  if (cached !== undefined) return cached;
  const out = convertHanText(text);
  if (textCache.size >= TEXT_CACHE_MAX) textCache.clear();
  textCache.set(text, out);
  return out;
}

/** 字符串列表的显示副本（全部无变化时返回原数组，便于下游按引用跳过重算） */
export function hanTextList(list: readonly string[] | undefined): string[] | undefined {
  if (!list || list.length === 0) return list as string[] | undefined;
  if (hanVersion() === 0) return list as string[] | undefined;
  let out: string[] | null = null;
  for (let i = 0; i < list.length; i++) {
    const next = hanText(list[i]);
    if (out) {
      out.push(next);
    } else if (next !== list[i]) {
      out = list.slice(0, i);
      out.push(next);
    }
  }
  return out ?? (list as string[]);
}

interface HanMetaFields {
  title: string;
  author: string;
  intro?: string;
  tags?: string[];
}

/**
 * 元信息显示副本：书名 / 作者 / 简介 / 标签（不含章节与正文，
 * 章节标题与正文见 withHanBook）。无改动时返回原对象。
 */
export function withHanMeta<T extends HanMetaFields>(meta: T | undefined): T | undefined {
  if (!meta || hanVersion() === 0) return meta;
  const title = hanText(meta.title);
  const author = hanText(meta.author);
  const intro = meta.intro === undefined ? undefined : hanText(meta.intro);
  const tags = hanTextList(meta.tags);
  if (
    title === meta.title &&
    author === meta.author &&
    intro === meta.intro &&
    tags === meta.tags
  ) {
    return meta;
  }
  return {
    ...meta,
    title,
    author,
    ...(intro === undefined ? {} : { intro }),
    ...(tags === undefined ? {} : { tags }),
  };
}

/** 正文块显示副本（图片块无文字，原样复用） */
function convertBlocks(blocks: ChapterBlock[]): ChapterBlock[] {
  let changed = false;
  const out = blocks.map((block) => {
    if (block.kind === "img") return block;
    const text = hanText(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? out : blocks;
}

/** 章节副本：字段按需转换（惰性），对象身份在同版本内稳定 */
function createChapterView(chapter: LocalBookChapter): LocalBookChapter {
  let title: string | null = null;
  let paragraphs: string[] | null = null;
  let blocks: ChapterBlock[] | undefined;
  let blocksRead = false;
  return {
    cid: chapter.cid,
    url: chapter.url,
    get title(): string {
      return (title ??= hanText(chapter.title));
    },
    get paragraphs(): string[] {
      return (paragraphs ??= hanTextList(chapter.paragraphs) ?? []);
    },
    get blocks(): ChapterBlock[] | undefined {
      if (!blocksRead) {
        blocksRead = true;
        blocks = chapter.blocks ? convertBlocks(chapter.blocks) : undefined;
      }
      return blocks;
    },
  } as LocalBookChapter;
}

const chapterViews = new WeakMap<
  LocalBookChapter,
  { version: number; view: LocalBookChapter }
>();
/** 已经是显示副本的对象：重复包装时原样返回，避免二次转换 */
const chapterViewSet = new WeakSet<LocalBookChapter>();
const bookViewSet = new WeakSet<LocalBook>();
const bookViews = new WeakMap<LocalBook, { version: number; view: LocalBook }>();

/** 章节显示副本（同一原章节 + 同一词典版本复用同一个副本对象） */
function withHanChapter(chapter: LocalBookChapter): LocalBookChapter {
  if (chapterViewSet.has(chapter)) return chapter;
  const version = hanVersion();
  if (version === 0) return chapter;
  const cached = chapterViews.get(chapter);
  if (cached && cached.version === version) return cached.view;
  const view = createChapterView(chapter);
  chapterViewSet.add(view);
  chapterViews.set(chapter, { version, view });
  return view;
}

/**
 * 书籍显示副本：元信息（书名 / 作者 / 简介 / 标签）+ 章节副本。
 * 目录、正文、听书、全书搜索都应读它；书库写入一律走原始对象（localBookById）。
 */
export function withHanBook(book: LocalBook | undefined): LocalBook | undefined {
  if (!book || bookViewSet.has(book)) return book;
  const version = hanVersion();
  if (version === 0) return book;
  const cached = bookViews.get(book);
  if (cached && cached.version === version) return cached.view;
  const meta = withHanMeta(book) ?? book;
  const view: LocalBook = {
    ...meta,
    chapters: book.chapters.map(withHanChapter),
  };
  bookViewSet.add(view);
  bookViews.set(book, { version, view });
  return view;
}
