import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

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
const types = await load("../src/lib/booksTypes.ts", {});
const pagination = await load("../src/lib/pagination.ts", {
  "./booksTypes": types, "./i18n": { t: (key) => key },
  "./logger": { createLogger: () => ({ warn() {} }) },
});
let latest;
let writes = 0;
let failWrite = false;
const { chapterEditText, editedChapter, saveChapterEdit } = await load("../src/lib/chapterEditing.ts", {
  "./pagination": pagination,
  "./books": { async updateBookChapters(id, updates, filter) {
    assert.equal(id, "book1");
    const usable = updates.filter((update) => filter(update, latest));
    if (!usable.length) return 0;
    if (failWrite) throw new Error("disk failure");
    writes++;
    for (const update of usable) latest.chapters[update.index] = update.chapter;
    return usable.length;
  } },
});
const chapter = { cid: "c1", title: "Title", url: "chapter-url", paragraphs: ["stale"], blocks: [
  { kind: "img", local: "lead", alt: "cover" },
  { kind: "h", level: 2, text: "Heading" },
  { kind: "p", text: "hello world", imgs: [{ at: 6, remote: "image-url", local: "inline" }] },
  { kind: "img", remote: "tail-url", local: "tail" },
] };
const original = structuredClone(chapter);
assert.equal(chapterEditText(chapter), "Heading\nhello world", "blocks 优先，不取陈旧 paragraphs");
assert.equal(editedChapter(chapter, chapterEditText(chapter)), chapter, "无改动保持结构与引用");
const next = editedChapter(chapter, "Heading\nhello wonderful world");
assert.deepEqual(chapter, original, "不修改原对象");
assert.equal(next.cid, chapter.cid);
assert.equal(next.title, chapter.title);
assert.equal(next.url, chapter.url);
assert.deepEqual(next.paragraphs, ["Heading", "hello wonderful world"]);
assert.deepEqual(next.blocks[0], { ...chapter.blocks[0], src: "" });
assert.deepEqual(next.blocks[1], chapter.blocks[1], "未改动小标题保留层级");
assert.equal(next.blocks[2].imgs[0].at, 6, "插入点之前的段内图保持锚点");
assert.equal(next.blocks.at(-1).local, "tail", "尾图保持在结尾");
const inserted = editedChapter(chapter, "New paragraph\nHeading\nhello world");
const inline = inserted.blocks.find((b) => b.kind === "p" && b.imgs?.length);
assert.equal(inline.text, "hello world");
assert.equal(inline.imgs[0].at, 6, "增加段落后图片锚点跟随文本");
const empty = editedChapter(chapter, "");
assert.equal(chapterEditText(empty), "");
assert.equal(empty.blocks.filter((b) => b.kind === "img").length, 2);
assert.equal(empty.blocks.find((b) => b.kind === "p").imgs[0].local, "inline", "删光正文仍保留全部图片");
assert.equal(empty.blocks.find((b) => b.kind === "p").imgs[0].at, 0);
const legacy = { cid: "c2", title: "Legacy", paragraphs: ["one", "two"] };
assert.equal(chapterEditText(legacy), "one\ntwo");
assert.deepEqual(editedChapter(legacy, "one\r\nthree\rfour").paragraphs, ["one", "three", "four"]);
assert.deepEqual(editedChapter(legacy, "").paragraphs, [""]);
const imageOnly = { cid: "c3", title: "PDF", paragraphs: [], blocks: [{ kind: "img", local: "page" }] };
assert.equal(chapterEditText(imageOnly), "");
assert.equal(editedChapter(imageOnly, "Caption").blocks[0].local, "page");
console.log("chapter editing: 原文、分段、空章、结构、图片引用和锚点通过");

latest = { chapters: [structuredClone(chapter), structuredClone(legacy)] };
latest.chapters[0].blocks[2].imgs[0].local = "newly-downloaded";
assert.ok(await saveChapterEdit("book1", 0, chapter, "Heading\nEdited"));
assert.equal(latest.chapters[0].blocks.find((b) => b.imgs?.length).imgs[0].local, "newly-downloaded");
assert.deepEqual(latest.chapters[1], legacy, "只修改目标章节");
const beforeConflict = structuredClone(latest);
assert.equal(await saveChapterEdit("book1", 0, chapter, "stale draft"), false, "拒绝覆盖已改变的正文");
assert.deepEqual(latest, beforeConflict);
assert.equal(writes, 1);
latest = { chapters: [structuredClone(chapter)] };
latest.chapters[0].cid = "different-cid";
assert.equal(await saveChapterEdit("book1", 0, chapter, "wrong chapter"), false);
latest = { chapters: [structuredClone(chapter)] };
latest.chapters[0].url = "new-url";
assert.equal(await saveChapterEdit("book1", 0, chapter, "changed toc"), false);
latest = { chapters: [] };
assert.equal(await saveChapterEdit("book1", 0, chapter, "removed chapter"), false);
latest = { chapters: [structuredClone(chapter)] };
failWrite = true;
await assert.rejects(saveChapterEdit("book1", 0, chapter, "unsaved"), /disk failure/);
assert.deepEqual(latest.chapters[0], chapter, "写失败保持原文");
failWrite = false;
assert.ok(await saveChapterEdit("book1", 0, chapter, "retried"), "写失败后可重试");
console.log("chapter editing: 保存、并发冲突、目录变动、删除与写失败保护通过");
