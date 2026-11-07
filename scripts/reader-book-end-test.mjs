import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createEffect, createRoot, createSignal, on } from "../node_modules/solid-js/dist/solid.js";

const endSource = await readFile(new URL("../src/lib/readerBookEnd.ts", import.meta.url), "utf8");
const { outputText: endJs } = ts.transpileModule(endSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { bookEndDragTarget, stepBookEnd } = await import(
  `data:text/javascript;base64,${Buffer.from(endJs).toString("base64")}`,
);

for (const columns of [1, 2]) {
  const step = columns;
  assert.equal(stepBookEnd({
    dir: 1, atEnd: false, hasNextContent: true, isLastChapter: true, hasPages: true,
  }), null, "本章还有下一屏时不进入完结页");
  assert.equal(stepBookEnd({
    dir: 1, atEnd: false, hasNextContent: false, isLastChapter: false, hasPages: true,
  }), null, "非最后一章的末屏仍跨章");
  assert.deepEqual(stepBookEnd({
    dir: 1, atEnd: false, hasNextContent: false, isLastChapter: true, hasPages: true,
  }), { atEnd: true, moved: true }, "最后一章末屏再向前进入完结页");
  assert.deepEqual(stepBookEnd({
    dir: 1, atEnd: true, hasNextContent: false, isLastChapter: true, hasPages: true,
  }), { atEnd: true, moved: false }, "完结页后再向前没有位移");
  assert.deepEqual(stepBookEnd({
    dir: -1, atEnd: true, hasNextContent: false, isLastChapter: true, hasPages: false,
  }), { atEnd: false, moved: true }, "排版重来时仍可从完结页回翻");
  assert.equal(stepBookEnd({
    dir: 1, atEnd: false, hasNextContent: false, isLastChapter: true, hasPages: false,
  }), null, "分页未就绪不能进入完结页");
  assert.equal(stepBookEnd({
    dir: -1, atEnd: false, hasNextContent: false, isLastChapter: true, hasPages: true,
  }), null);
  assert.equal(bookEndDragTarget({
    dir: 1, atEnd: false, nextSpread: step, totalPages: step * 3, isLastChapter: true, isFirstChapter: false,
  }), "content");
  assert.equal(bookEndDragTarget({
    dir: 1, atEnd: false, nextSpread: step * 3, totalPages: step * 3, isLastChapter: true, isFirstChapter: false,
  }), "end", "末屏向前预览完结页");
  assert.equal(bookEndDragTarget({
    dir: 1, atEnd: false, nextSpread: step * 3, totalPages: step * 3, isLastChapter: false, isFirstChapter: false,
  }), "cross");
  assert.equal(bookEndDragTarget({
    dir: -1, atEnd: false, nextSpread: -step, totalPages: step * 3, isLastChapter: false, isFirstChapter: true,
  }), "none");
  assert.equal(bookEndDragTarget({
    dir: -1, atEnd: true, nextSpread: step, totalPages: step * 3, isLastChapter: true, isFirstChapter: false,
  }), "back", "完结页回翻预览当前正文屏，不能跳到再上一屏");
  assert.equal(bookEndDragTarget({
    dir: 1, atEnd: true, nextSpread: step * 4, totalPages: step * 3, isLastChapter: true, isFirstChapter: false,
  }), "none");
  assert.equal(bookEndDragTarget({
    dir: 1, atEnd: false, nextSpread: step, totalPages: 0, isLastChapter: false, isFirstChapter: false,
  }), "cross", "本章还没排好时仍可向后跨章");
  assert.equal(bookEndDragTarget({
    dir: 1, atEnd: false, nextSpread: step, totalPages: 0, isLastChapter: true, isFirstChapter: true,
  }), "none");
}

const source = await readFile(new URL("../src/pages/Reader.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("Reader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
let ratio;
let clamp;
let retain;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "createEffect") {
    const text = node.getText(ast);
    if (text.includes("on(totalPages,")) ratio = text;
    if (text.includes("idx >= total")) clamp = text;
    if (text.includes("retainBookEnd")) retain = text;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of ["turnPage", "goToChapter", "seekToPage"]) {
  assert.ok(functions.has(name), `缺少 Reader.${name}`);
}
assert.ok(ratio && clamp && retain, "重排必须能留在完结页");
const { outputText } = ts.transpileModule([
  "let wantLastPageCid = null, browseChapterPending = false, retainBookEnd = false;",
  "function holdBookEnd() { retainBookEnd = true; }",
  functions.get("goToChapter"),
  functions.get("turnPage"),
  functions.get("seekToPage"),
  ratio, clamp, retain,
  "return { turnPage, goToChapter, seekToPage };",
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });

function spreadStart(page, columns) {
  const index = Math.max(0, Math.floor(page) || 0);
  return columns > 1 ? index - (index % columns) : index;
}

function scenario({ columns = 1, pages = 5, chapters = 2, chapter = 0, page = 0 } = {}) {
  let state;
  const dispose = createRoot((cleanup) => {
    const list = Array.from({ length: chapters }, (_, index) => ({ cid: `c${index}` }));
    const [chapterIdx, setChapterIdx] = createSignal(chapter);
    const [pageIdx, setPageIdx] = createSignal(page);
    const [pageCount, setPageCount] = createSignal(pages);
    const [atBookEnd, setAtBookEnd] = createSignal(false);
    const cleared = [];
    const logs = [];
    const book = () => ({ chapters: list });
    const snapPage = (value) => {
      const total = pageCount();
      if (total <= 0) return 0;
      const clamped = Math.min(Math.max(0, Math.round(value)), total - 1);
      return spreadStart(clamped, columns);
    };
    const dependencies = {
      createEffect, on, isPaged: () => true, totalPages: pageCount, snapPage, pageIdx, setPageIdx,
      pageColumns: () => columns, stepBookEnd, atBookEnd, setAtBookEnd,
      isLastChapter: () => chapterIdx() + 1 >= list.length,
      isFirstChapter: () => chapterIdx() <= 0,
      offerJumpBack: () => {}, armFollowPageCheck: () => {},
      cancelFollowIfActive: () => cleared.push("follow"),
      setSelSpan: () => cleared.push("selection"),
      setSelMenu: () => cleared.push("menu"),
      setTranslationTarget: () => cleared.push("translation"),
      log: { info: (message) => logs.push(message) },
      chapterIdx, book, renderBook: book, setChapterIdx, setViewOffset: () => {},
    };
    const actions = new Function(...Object.keys(dependencies), outputText)(...Object.values(dependencies));
    state = {
      ...actions, chapterIdx, pageIdx, atBookEnd, setPageCount, cleared, logs, setAtBookEnd, setPageIdx,
    };
    return cleanup;
  });
  return { ...state, dispose };
}

for (const columns of [1, 2]) {
  const pages = columns === 1 ? 5 : 5;
  const last = spreadStart(pages - 1, columns);
  const reading = scenario({ columns, pages, chapter: 1 });
  assert.equal(reading.turnPage(1), true);
  assert.equal(reading.pageIdx(), columns);
  assert.equal(reading.atBookEnd(), false, "章内翻页不进入完结页");
  reading.setPageIdx(last);
  reading.cleared.length = 0;
  reading.logs.length = 0;
  assert.equal(reading.turnPage(1), true, "最后一章末屏可以再翻一页");
  assert.equal(reading.chapterIdx(), 1);
  assert.equal(reading.pageIdx(), last, "完结页不改底下的正文页码");
  assert.equal(reading.atBookEnd(), true);
  assert.deepEqual(reading.cleared, ["follow", "selection", "menu", "translation"]);
  assert.deepEqual(reading.logs, ["打开全书完结页"]);
  assert.equal(reading.turnPage(1), false, "完结页后再向前停住");
  assert.equal(reading.atBookEnd(), true);
  assert.equal(reading.pageIdx(), last);
  assert.equal(reading.turnPage(-1), true);
  assert.equal(reading.atBookEnd(), false, "回翻回到进入前的正文屏");
  assert.equal(reading.pageIdx(), last);
  assert.equal(reading.turnPage(-1), true);
  assert.equal(reading.pageIdx(), Math.max(0, last - columns));
  reading.dispose();

  const earlier = scenario({ columns, pages, chapters: 3, chapter: 0 });
  earlier.setPageIdx(last);
  assert.equal(earlier.turnPage(1), true);
  assert.equal(earlier.chapterIdx(), 1, "非最后一章末屏仍进入下一章");
  assert.equal(earlier.pageIdx(), 0);
  assert.equal(earlier.atBookEnd(), false);
  earlier.dispose();
}

const sameChapter = scenario({ pages: 4, chapter: 1, page: 2 });
sameChapter.turnPage(1);
sameChapter.turnPage(1);
assert.equal(sameChapter.atBookEnd(), true);
sameChapter.goToChapter(1);
assert.equal(sameChapter.atBookEnd(), false, "再次打开当前章时离开完结页");
assert.equal(sameChapter.pageIdx(), 3, "当前章不强制回到章首");
sameChapter.turnPage(1);
assert.equal(sameChapter.atBookEnd(), true);
sameChapter.seekToPage(2);
assert.equal(sameChapter.atBookEnd(), false, "进度条跳回当前屏时离开完结页");
assert.equal(sameChapter.pageIdx(), 2);
sameChapter.dispose();

const relayout = scenario({ columns: 2, pages: 1, chapter: 1, page: 0 });
assert.equal(relayout.turnPage(1), true);
assert.equal(relayout.atBookEnd(), true);
relayout.setPageCount(4);
assert.equal(relayout.pageIdx(), 2, "页数变多后回翻落点夹到新的最后一屏");
assert.equal(relayout.atBookEnd(), true, "重排不离开完结页");
relayout.setPageIdx(0);
assert.equal(relayout.atBookEnd(), false, "正文翻页或跳页离开完结页");
relayout.dispose();

process.stdout.write("全书完结页回归通过：末屏再翻、回翻、跨章、单双页、进度跳页与重排\n");
