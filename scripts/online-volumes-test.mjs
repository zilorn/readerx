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
  "./chapterImages": {}, "./bookmarks": {}, "./bookSources": {}, "./sourceCover": {},
  "./logger": { createLogger: () => ({ info() {}, debug() {}, warn() {} }) },
  "./i18n": { t: (key) => key },
  "./books": {
    async addBookRecord(next) { book = next; },
    ensureLocalBookContent: async () => book,
    localBookById: () => book,
    async updateBookContent(id, updater) {
      assert.equal(id, book.id);
      book = updater(book);
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
book.chapters[0] = { ...book.chapters[0], paragraphs: ["已有正文"], blocks: [{ kind: "p", text: "已有正文" }] };
const cid = book.chapters[0].cid;
const changed = toc.map((ch, i) => i === 0 ? { ...ch, chapterName: "Renamed", volume: "卷名更正" } : ch);
const diff = online.diffOnlineBookToc(book, changed);
assert.equal(diff.kind, "metadata");
await online.applyOnlineTocAppend(book.id, [], diff.prefix);
assert.equal(book.chapters[0].volume, "卷名更正");
assert.equal(book.chapters[0].title, "Renamed");
assert.equal(book.chapters[0].cid, cid);
assert.deepEqual(book.chapters[0].paragraphs, ["已有正文"]);
assert.equal(book.chapters[0].blocks[0].text, "已有正文");
const appended = [...changed, { chapterName: "New", chapterUrl: "https://example.com/4", volume: "第三卷" }];
appended[1] = { ...appended[1], volume: "第二卷 更名" };
const append = online.diffOnlineBookToc(book, appended);
assert.equal(append.kind, "append");
assert.equal(await online.applyOnlineTocAppend(book.id, append.added, append.prefix), 1);
assert.equal(book.chapters[1].volume, "第二卷 更名");
assert.equal(book.chapters[3].volume, "第三卷");
await assert.rejects(online.applyOnlineTocAppend(book.id, append.added, append.prefix), /tocChanged/, "过期追加不得重复加章");
const reordered = [appended[1], appended[0], ...appended.slice(2)];
assert.equal(online.diffOnlineBookToc(book, reordered).kind, "conflict");
await online.applyOnlineTocOverwrite(book.id, reordered);
assert.equal(book.chapters[1].volume, "卷名更正");
assert.deepEqual(book.chapters[1].paragraphs, ["已有正文"], "覆盖目录按地址保留正文");
const plain = reordered.map(({ volume, ...chapter }) => chapter);
const removeVolume = online.diffOnlineBookToc(book, plain);
assert.equal(removeVolume.kind, "metadata");
await online.applyOnlineTocAppend(book.id, [], removeVolume.prefix);
assert.ok(book.chapters.every((ch) => ch.volume === undefined));
await online.switchOnlineBookSource(book.id, { id: "new" }, item, appended);
assert.equal(book.chapters[0].volume, "卷名更正");
assert.deepEqual(book.chapters[0].paragraphs, [], "换源不复用旧正文");
beforeWrite = () => { book.chapters[0] = { ...book.chapters[0], volume: "并发更新后的卷", title: "最新标题" }; };
const reload = await online.reloadChapterContent(book.id, 0);
assert.equal(reload.applied, true, reload.error);
assert.equal(receivedChapter.volume, "卷名更正", "正文请求向脚本透传卷信息");
assert.equal(book.chapters[0].volume, "并发更新后的卷", "在飞正文不得覆盖最新卷名");
assert.equal(book.chapters[0].title, "最新标题");
assert.deepEqual(book.chapters[0].paragraphs, ["下载后的正文"]);
response = [{ chapterName: "Empty volume", chapterUrl: "https://example.com/1", volume: "  " }];
assert.equal((await online.fetchBookToc(source, item))[0].volume, undefined);
console.log("BookSource volumes: 归一化、入架、目录更名/增删分卷、追加/覆盖/换源、正文参数与并发回写通过");
