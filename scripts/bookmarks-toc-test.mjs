import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createSignal } from "solid-js";

async function load(path, deps) {
  const code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => {
    assert.ok(name in deps, `Unexpected import ${name}`);
    return deps[name];
  }, exports);
  return exports;
}

const store = new Map();
const types = await load("../src/lib/booksTypes.ts", {});
const fuzzy = await load("../src/lib/fuzzy.ts", {});
const pagination = {
  chapterUnits(chapter) {
    const blocks = chapter.blocks;
    if (blocks && blocks.length > 0) return blocks;
    return chapter.paragraphs.map((text) => ({ kind: "p", text }));
  },
};
const bookmarks = await load("../src/lib/bookmarks.ts", {
  "solid-js": { createSignal },
  "./backend": {
    async readRemoteBookmarks(bookId) {
      return store.has(bookId) ? structuredClone(store.get(bookId)) : [];
    },
    async saveRemoteBookmarks(bookId, list) {
      store.set(bookId, structuredClone(list));
    },
  },
  "./booksTypes": types,
  "./i18n": { t: (key) => key },
  "./pagination": pagination,
});
const migration = await load("../src/lib/bookmarkMigration.ts", {
  "./pagination": pagination,
  "./fuzzy": fuzzy,
  "./booksTypes": types,
  "./bookmarks": bookmarks,
});
const transfer = await load("../src/lib/bookmarkTransfer.ts", {
  "./booksTypes": types,
  "./bookmarks": bookmarks,
  "./bookmarkMigration": migration,
  "./i18n": { t: (key) => key },
});

const aText = "风停了，他抬头看向远方的山。";
const bText = "雨落在屋檐上，滴答滴答。";
const chapter = (cid, title, text, volume) => ({
  cid,
  title,
  ...(volume ? { volume } : {}),
  paragraphs: [text],
  blocks: [{ kind: "p", text }],
});
const a = chapter("c0001", "第一章 风起", aText, "第一卷");
const b = chapter("c0002", "第二章 雨落", bText, "第一卷");
const c = chapter("c0003", "第三章 云散", "云散了。");

function makeMark(bookId, chapterValue, index, start, end, title = chapterValue.title) {
  const mirror = bookmarks.buildTextMirror(pagination.chapterUnits(chapterValue));
  const mark = bookmarks.makeBookmark(bookId, chapterValue, index, 0, start, end, mirror);
  assert.ok(mark);
  mark.id = `bm-${chapterValue.cid}`;
  mark.chapterTitle = title;
  mark.createdAt = 1;
  return mark;
}

// 1) 旧版本整本覆盖后：书签 cid 指向新插入的章节，按标题 + 正文迁移回原章节。
{
  const bookId = "book-1";
  const mark = makeMark(bookId, a, 0, 4, 12);
  store.set(bookId, [structuredClone(mark)]);
  const x = chapter("c0001", "序章 新增", "这是后来插入的序章。", "第一卷");
  const a2 = chapter("c0002", "第一章 风起", aText, "第一卷");
  const b2 = chapter("c0003", "第二章 雨落", bText, "第一卷");
  const c2 = chapter("c0004", "第三章 云散", "云散了。", "第二卷");
  const result = await migration.migrateBookmarksForToc(bookId, [x, a2, b2, c2]);
  assert.deepEqual(result, { total: 1, repaired: 1, migrated: 1, unresolved: 0 });
  const fixed = (await bookmarks.bookmarksFor(bookId))[0];
  assert.equal(fixed.chapterCid, "c0002");
  assert.equal(fixed.chapterIndex, 1);
  assert.equal(fixed.chapterTitle, "第一章 风起");
  assert.equal(fixed.chapterVolume, "第一卷");
  assert.equal(fixed.text, aText.slice(4, 12));
  assert.equal(fixed.charStart, 4);
  assert.equal(fixed.charEnd, 12);
  assert.equal(fixed.before, aText.slice(0, 4));
  assert.equal(fixed.after, aText.slice(12));
}

// 2) 同一 cid 只改了标题、正文没变：保留 cid，刷新目录头。
{
  const bookId = "book-2";
  const mark = makeMark(bookId, a, 0, 4, 12);
  store.set(bookId, [structuredClone(mark)]);
  const renamed = { ...a, title: "第一章 风起（修订）" };
  const result = await migration.migrateBookmarksForToc(bookId, [renamed, b]);
  assert.deepEqual(result, { total: 1, repaired: 1, migrated: 0, unresolved: 0 });
  const fixed = (await bookmarks.bookmarksFor(bookId))[0];
  assert.equal(fixed.chapterCid, "c0001");
  assert.equal(fixed.chapterTitle, "第一章 风起（修订）");
}

// 3) cid 丢失、同名章节尚未缓存正文：按标题迁移并保留偏移。
{
  const bookId = "book-3";
  const mark = makeMark(bookId, a, 0, 4, 12);
  mark.chapterCid = "c9999";
  store.set(bookId, [structuredClone(mark)]);
  const uncached = { cid: "c0010", title: "第一章 风起", volume: "第一卷", paragraphs: [] };
  const result = await migration.migrateBookmarksForToc(bookId, [uncached, b]);
  assert.deepEqual(result, { total: 1, repaired: 1, migrated: 1, unresolved: 0 });
  const fixed = (await bookmarks.bookmarksFor(bookId))[0];
  assert.equal(fixed.chapterCid, "c0010");
  assert.equal(fixed.charStart, 4);
}

// 4) 找不到可靠章节：原样保留，计数 unresolved，绝不猜一个位置。
{
  const bookId = "book-4";
  const mark = makeMark(bookId, a, 0, 4, 12);
  mark.chapterCid = "c9999";
  mark.chapterTitle = "不存在的章节";
  mark.text = "完全找不到的一段文字";
  store.set(bookId, [structuredClone(mark)]);
  const result = await migration.migrateBookmarksForToc(bookId, [a, b, c]);
  assert.deepEqual(result, { total: 1, repaired: 0, migrated: 0, unresolved: 1 });
  assert.deepEqual(await bookmarks.bookmarksFor(bookId), [mark]);
}

// 4b) 章节名被轻微改写、正文大部分仍相似：按标题相似度 + 正文覆盖率迁移。
{
  const bookId = "book-4b";
  const longText = "风停了，他抬头看向远方的山，山谷里升起薄薄的雾，像是在等待什么。";
  const bookmarkText = longText.slice(0, 24);
  const source = chapter("c0001", "第一章 风起", longText, "第一卷");
  const mark = makeMark(bookId, source, 0, 0, 24);
  mark.chapterCid = "c9998";
  mark.chapterTitle = "第一章 风起";
  store.set(bookId, [structuredClone(mark)]);
  const unrelated = chapter("c0001", "序章 新增", "这是后来插入的序章。", "第一卷");
  const target = chapter(
    "c0002",
    "第一章 风起时",
    "雨来了，他抬头看向远方的山，山谷里升起薄薄的雾，像是在等待什么。",
    "第一卷",
  );
  const result = await migration.migrateBookmarksForToc(bookId, [unrelated, target]);
  assert.deepEqual(result, { total: 1, repaired: 1, migrated: 1, unresolved: 0 });
  assert.equal((await bookmarks.bookmarksFor(bookId))[0].chapterCid, "c0002");
}

// 5) 导出：数组包含书名 / 章节名 / 章节 ID / 卷名；没有卷时省略 volumeName。
{
  const book = { id: "book-5", title: "测试书", chapters: [a, b, c] };
  const markA = makeMark("book-5", a, 0, 4, 12);
  const markB = makeMark("book-5", b, 1, 2, 8);
  const markC = makeMark("book-5", c, 2, 0, 2);
  const items = transfer.exportBookmarkItems(book, [markA, markB, markC]);
  assert.equal(items.length, 3);
  assert.equal(items[0].bookName, "测试书");
  assert.equal(items[0].chapterName, "第一章 风起");
  assert.equal(items[0].chapterId, "c0001");
  assert.equal(items[0].volumeName, "第一卷");
  assert.equal(items[1].chapterId, "c0002");
  assert.equal(items[2].chapterId, "c0003");
  assert.ok(!("volumeName" in items[2]), "没有卷时不写 volumeName");
  assert.equal(items[0].text, aText.slice(4, 12));

  const parsed = transfer.parseBookmarkExport(JSON.stringify(items));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].bookName, "测试书");
  assert.equal(parsed[2].volumeName, undefined);
}

// 6) 导入：cid 变化时按章节名 + 卷名重新对应，按 id 更新并重新锚定正文。
{
  const sourceBook = { id: "book-6", title: "测试书", chapters: [a, b] };
  const markA = makeMark("book-6", a, 0, 4, 12);
  const markB = makeMark("book-6", b, 1, 2, 8);
  const items = transfer.parseBookmarkExport(
    JSON.stringify(transfer.exportBookmarkItems(sourceBook, [markA, markB])),
  );
  const na = chapter("c0007", "第一章 风起", aText, "第一卷");
  const nb = chapter("c0008", "第二章 雨落", bText, "第一卷");
  const target = { id: "book-6", title: "测试书", chapters: [na, nb] };
  const plan = transfer.planBookmarkImport(target, [], items);
  assert.equal(plan.imported, 2);
  assert.equal(plan.updated, 0);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.bookmarks[0].chapterCid, "c0007");
  assert.equal(plan.bookmarks[1].chapterCid, "c0008");
  assert.equal(plan.bookmarks[0].charStart, 4);
  assert.equal(plan.bookmarks[1].charStart, 2);
  assert.equal(plan.bookmarks[0].chapterVolume, "第一卷");
  assert.ok(!("chapterVolume" in plan.bookmarks[1]) || plan.bookmarks[1].chapterVolume === "第一卷");

  const again = transfer.planBookmarkImport(target, plan.bookmarks, items);
  assert.equal(again.imported, 0);
  assert.equal(again.updated, 2);
  assert.equal(again.bookmarks.length, 2);
}

// 7) 导入文件里的章节 ID 过期、但章节名仍能对应时，按标题纠正。
{
  const target = { id: "book-7", title: "测试书", chapters: [a, b] };
  const item = {
    bookName: "测试书",
    chapterName: "第二章 雨落",
    chapterId: "c0001",
    volumeName: "第一卷",
    chapterIndex: 0,
    text: bText.slice(2, 8),
    before: bText.slice(0, 2),
    after: bText.slice(8),
    unitIndex: 0,
    charStart: 2,
    charEnd: 8,
    createdAt: 1,
  };
  const plan = transfer.planBookmarkImport(target, [], [item]);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.bookmarks[0].chapterCid, "c0002");
  assert.equal(plan.bookmarks[0].chapterTitle, "第二章 雨落");
}

// 7b) 导入时 cid 仍存在、标题对不上且正文未缓存：信任用户给出的章节 ID。
{
  const target = {
    id: "book-7b",
    title: "测试书",
    chapters: [{ cid: "c0020", title: "新章节名", paragraphs: [] }, b],
  };
  const item = {
    bookName: "测试书",
    chapterName: "旧章节名",
    chapterId: "c0020",
    chapterIndex: 0,
    text: "未缓存正文中的一段书签",
    before: "",
    after: "",
    unitIndex: 0,
    charStart: 2,
    charEnd: 10,
    createdAt: 1,
  };
  const plan = transfer.planBookmarkImport(target, [], [item]);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.imported, 1);
  assert.equal(plan.bookmarks[0].chapterCid, "c0020");
}

// 8) 非法文件 / 无书签文件给出可读错误。
{
  assert.throws(() => transfer.parseBookmarkExport("not json"), /importInvalid/);
  assert.throws(() => transfer.parseBookmarkExport("{}"), /importInvalid/);
  assert.throws(() => transfer.parseBookmarkExport("[]"), /importEmpty/);
  assert.throws(
    () => transfer.parseBookmarkExport(JSON.stringify([{ chapterName: "无正文" }])),
    /importEmpty/,
  );
}

// 9) 落盘包装：读取已存书签导出，再导入回同一本书。
{
  const bookId = "book-8";
  const book = { id: bookId, title: "落盘测试", chapters: [a, b] };
  const mark = makeMark(bookId, a, 0, 4, 12);
  store.set(bookId, [structuredClone(mark)]);
  const exported = await transfer.readBookmarksForExport(book);
  assert.equal(exported.count, 1);
  const parsed = transfer.parseBookmarkExport(exported.contents);
  const result = await transfer.importBookmarks(book, parsed);
  assert.equal(result.updated, 1);
  assert.equal(store.get(bookId).length, 1);
  assert.equal(store.get(bookId)[0].chapterCid, "c0001");
  assert.equal(store.get(bookId)[0].text, aText.slice(4, 12));
}

// 10) 新建书签记录卷名，供后续导出与迁移使用。
{
  const mirror = bookmarks.buildTextMirror(pagination.chapterUnits(a));
  const mark = bookmarks.makeBookmark("book-9", a, 0, 0, 4, 12, mirror);
  assert.equal(mark.chapterVolume, "第一卷");
  assert.equal(transfer.bookmarkExportFileName("测试/书:名"), "readerx-bookmarks-测试_书_名.json");
}

console.log("Bookmarks: 目录错位修复、标题/正文迁移、导出导入、卷名与落盘通过");
