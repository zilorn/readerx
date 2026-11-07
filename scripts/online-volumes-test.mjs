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
const booksSource = await readFile(new URL("../src/lib/books.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("books.ts", booksSource, ts.ScriptTarget.Latest, true);
const patchFunction = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "withPatchedChapters");
assert.ok(patchFunction);
const patchCode = ts.transpileModule(patchFunction.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const patchBook = new Function(`${patchCode}; return withPatchedChapters;`)();
const types = await load("../src/lib/booksTypes.ts", {});
const content = await load("../src/lib/sourceContent.ts", { "./booksTypes": types });
let book;
let response;
let receivedChapter;
let beforeWrite;
const migrations = [];
const online = await load("../src/lib/online.ts", {
  "solid-js": { createSignal }, "./booksTypes": types, "./sourceContent": content,
  "./translation/engine": { invalidateTranslations: async () => {} },
  "./backend": {
    callRemoteSource: async () => ({ ok: true, value: response }),
    fetchRemoteChapterContents: async (_id, _book, chapters) => {
      receivedChapter = chapters[0];
      return [{ ok: true, chapterName: receivedChapter.chapterName, text: "下载后的正文" }];
    },
  },
  "./chapterImages": {}, "./bookSources": {}, "./sourceCover": {},
  "./bookmarks": {},
  "./bookmarkMigration": {
    async migrateBookmarksForToc(bookId, chapters) {
      migrations.push({ bookId, count: chapters.length });
      return { total: 0, repaired: 0, migrated: 0, unresolved: 0 };
    },
  },
  "./logger": { createLogger: () => ({ info() {}, debug() {}, warn() {} }) },
  "./i18n": { t: (key) => key },
  "./books": {
    async addBookRecord(next) { book = next; },
    ensureLocalBookContent: async () => book,
    localBookById: () => book,
    async updateBookContent(id, updater) {
      assert.equal(id, book.id);
      const next = updater(book);
      if (next) book = next;
      return book;
    },
    async updateBookChapters(_id, updates, filter) {
      beforeWrite?.();
      const usable = updates.filter((update) => filter(update, book));
      book = patchBook(book, usable);
      return usable.length;
    },
  },
});
const source = { id: "source", name: "Source" };
const item = { bookName: "Book", bookUrl: "https://example.com/book" };
response = [null, 7, {},
  { chapterName: " First ", chapterUrl: " https://example.com/1 ", volume: " 第一卷 " },
  { chapterName: "Second", chapterUrl: "https://example.com/2", volume: "第二卷" },
  { chapterName: "Legacy", chapterUrl: "https://example.com/3", volume: 2 },
  { chapterName: "No URL", volume: "第三卷" },
];
const toc = await online.fetchBookToc(source, item);
assert.equal(toc.length, 3);
assert.deepEqual(toc[0], { chapterName: "First", chapterUrl: "https://example.com/1", volume: "第一卷" });
assert.equal(toc[2].volume, undefined);
await online.addOnlineBookToShelf(source, item, toc);
assert.deepEqual(book.chapters.map((ch) => ch.volume), ["第一卷", "第二卷", undefined]);
assert.equal(online.diffOnlineBookToc(book, toc).kind, "none");

// 只在标题 / 卷名变化：保留 cid 与已缓存正文。
book.chapters[0] = { ...book.chapters[0], paragraphs: ["已有正文"], blocks: [{ kind: "p", text: "已有正文" }] };
book.chapters[2] = { ...book.chapters[2], paragraphs: ["第三章正文"], blocks: [{ kind: "p", text: "第三章正文" }] };
const cid0 = book.chapters[0].cid;
const cid2 = book.chapters[2].cid;
const changed = toc.map((ch, i) => i === 0 ? { ...ch, chapterName: "Renamed", volume: "卷名更正" } : ch);
const diff = online.diffOnlineBookToc(book, changed);
assert.equal(diff.kind, "merge");
assert.equal(diff.summary.changed, 1);
assert.equal(diff.summary.added, 0);
assert.equal(diff.summary.removed, 0);
await online.applyOnlineTocUpdate(book.id, diff.fresh);
assert.equal(book.chapters[0].volume, "卷名更正");
assert.equal(book.chapters[0].title, "Renamed");
assert.equal(book.chapters[0].cid, cid0);
assert.deepEqual(book.chapters[0].paragraphs, ["已有正文"]);
assert.equal(book.chapters[0].blocks[0].text, "已有正文");

// 末尾追加：既有 cid 与正文不动，新章分配未占用的 cid。
const appended = [...changed, { chapterName: "New", chapterUrl: "https://example.com/4", volume: "第三卷" }];
appended[1] = { ...appended[1], volume: "第二卷 更名" };
const append = online.diffOnlineBookToc(book, appended);
assert.equal(append.kind, "merge");
assert.equal(append.summary.added, 1);
assert.equal(append.summary.shifts, false);
await online.applyOnlineTocUpdate(book.id, append.fresh);
assert.equal(book.chapters[1].volume, "第二卷 更名");
assert.equal(book.chapters[3].volume, "第三卷");
assert.equal(book.chapters[3].cid, "c0004");
assert.equal(book.chapters[2].cid, cid2);
assert.equal(migrations.at(-1).count, 4);
const repeat = await online.applyOnlineTocUpdate(book.id, append.fresh);
assert.equal(repeat.summary.added, 0);
assert.equal(repeat.summary.removed, 0);
assert.equal(book.chapters.length, 4);

// 中段删一章、插一章：保留下来的章节 cid / 正文不变，新章不复用被删章节的 cid。
const [first, second, third, fourth] = appended;
assert.equal(second.chapterUrl, "https://example.com/2");
const middle = [first, third, { chapterName: "Inserted", chapterUrl: "https://example.com/x" }, fourth];
const middleDiff = online.diffOnlineBookToc(book, middle);
assert.equal(middleDiff.kind, "merge");
assert.equal(middleDiff.summary.removed, 1);
assert.equal(middleDiff.summary.added, 1);
assert.equal(middleDiff.summary.shifts, true);
await online.applyOnlineTocUpdate(book.id, middleDiff.fresh);
assert.equal(book.chapters.length, 4);
assert.equal(book.chapters[0].cid, cid0);
assert.equal(book.chapters[1].cid, cid2, "保留下来的第三章保持 cid");
assert.deepEqual(book.chapters[1].paragraphs, ["第三章正文"]);
assert.equal(book.chapters[3].cid, "c0004");
assert.notEqual(book.chapters[2].cid, "c0002", "被删章节的 cid 不复用");
assert.equal(book.chapters[2].title, "Inserted");
assert.equal(migrations.at(-1).count, 4);

// 重排：保留全部 cid / 正文，只更新下标。
const reordered = [middle[1], middle[0], middle[2], middle[3]];
const reorderedDiff = online.diffOnlineBookToc(book, reordered);
assert.equal(reorderedDiff.kind, "merge");
assert.equal(reorderedDiff.summary.reordered, true);
await online.applyOnlineTocUpdate(book.id, reorderedDiff.fresh);
assert.equal(book.chapters[0].cid, cid2);
assert.equal(book.chapters[1].cid, cid0);
assert.deepEqual(book.chapters[0].paragraphs, ["第三章正文"]);

// 移除全部卷名：只刷新目录头，不清正文 / cid。
const plain = reordered.map(({ volume, ...chapter }) => chapter);
const removeVolume = online.diffOnlineBookToc(book, plain);
assert.equal(removeVolume.kind, "merge");
await online.applyOnlineTocUpdate(book.id, removeVolume.fresh);
assert.ok(book.chapters.every((ch) => ch.volume === undefined));
assert.deepEqual(book.chapters[0].paragraphs, ["第三章正文"]);

// 换源仍然整本替换目录，不复用旧正文。
await online.switchOnlineBookSource(book.id, { id: "new" }, item, appended);
assert.equal(book.chapters[0].volume, "卷名更正");
assert.deepEqual(book.chapters[0].paragraphs, [], "换源不复用旧正文");

// 正文请求向脚本透传卷信息，且并发回写不得覆盖最新目录头。
beforeWrite = () => { book.chapters[0] = { ...book.chapters[0], volume: "并发更新后的卷", title: "最新标题" }; };
const reload = await online.reloadChapterContent(book.id, 0);
assert.equal(reload.applied, true, reload.error);
assert.equal(receivedChapter.volume, "卷名更正", "正文请求向脚本透传卷信息");
assert.equal(book.chapters[0].volume, "并发更新后的卷", "在飞正文不得覆盖最新卷名");
assert.equal(book.chapters[0].title, "最新标题");
assert.deepEqual(book.chapters[0].paragraphs, ["下载后的正文"]);
response = [{ chapterName: "Empty volume", chapterUrl: "https://example.com/1", volume: "  " }];
assert.equal((await online.fetchBookToc(source, item))[0].volume, undefined);
console.log("BookSource volumes: 归一化、入架、目录增量增删改/重排、cid 保留、正文与并发回写通过");
