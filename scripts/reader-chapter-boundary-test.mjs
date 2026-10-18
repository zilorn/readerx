import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  createComputed, createEffect, createMemo, createRoot, createSignal, on, onCleanup, untrack,
} from "../node_modules/solid-js/dist/solid.js";

// 联合执行实际翻页、异步分页、译文状态刷新和位置恢复，保留 Solid 浏览器运行时的更新顺序。
const source = await readFile(new URL("../src/pages/Reader.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("Reader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
let pagination, ratio, clamp, translationPosition;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isCallExpression(node)) {
    const text = node.getText(ast);
    if (node.expression.getText(ast) === "createEffect") {
      if (text.includes("const src = pageSource()")) pagination = text;
      if (text.includes("on(totalPages,")) ratio = text;
      if (text.includes("idx >= total")) clamp = text;
    }
    if (node.expression.getText(ast) === "createComputed" && text.includes("displayUnits()")) {
      translationPosition = text;
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
for (const code of [pagination, ratio, clamp, translationPosition]) assert.ok(code);
const translationSource = await readFile(new URL("../src/lib/translation/reader.ts", import.meta.url), "utf8");
const translationAst = ts.createSourceFile("reader.ts", translationSource, ts.ScriptTarget.Latest, true);
const translationHook = translationAst.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === "createReaderTranslation");
assert.ok(translationHook);
const names = ["snapPage", "goToChapter", "turnPage", "userFlip", "preserveTranslationPosition",
  "applyResume", "pageIndexOfChar", "captureReadingPos", "browseAdjacentChapter"];
for (const name of names) assert.ok(functions.has(name), `缺少 Reader.${name}`);
const { outputText } = ts.transpileModule([
  "let wantLastPageCid = null, browseChapterPending = false, paginateTask = null;",
  ...names.map(name => functions.get(name)),
  translationHook.getText(translationAst).replace(/^export /, ""),
  `const translation = createReaderTranslation({ bookId: () => "fixture", book, chapter,
    beforeChange: preserveTranslationPosition, startUnit: () => 0 });
  const displayUnits = createMemo(() => {
    const texts = translation.translations();
    return units().map((unit, index) => texts[index] ? { ...unit, translation: texts[index] } : unit);
  });
  const pageSource = createMemo(() => ({ ...chapter(), blocks: displayUnits() }));`,
  translationPosition, pagination, ratio, clamp,
  "return { userFlip, goToChapter, browseAdjacentChapter };",
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });

const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const spreadStart = (page, columns) => Math.floor(page / columns) * columns;
const pagesOf = count => ({ pages: Array.from({ length: count }, (_, index) => [
  { kind: "p", unit: 0, cstart: index * 100, text: "字".repeat(100) },
]) });

function scenario({ columns = 1, animated = false, translated = false } = {}) {
  let state;
  const dispose = createRoot(cleanup => {
    const chapters = ["a", "b", "c"].map(cid => ({ cid, paragraphs: [cid.repeat(1000)] }));
    const [chapterIdx, setChapterIdx] = createSignal(2);
    const [pageIdx, setPageIdx] = createSignal(0);
    const [paged, setPaged] = createSignal(null);
    const [resumeTarget, setResumeTarget] = createSignal(null);
    const [contentVersion, setContentVersion] = createSignal(0);
    const chapter = createMemo(() => chapters[chapterIdx()]);
    const chapterCid = createMemo(() => chapter().cid);
    const units = createMemo(() => {
      contentVersion();
      return [{ kind: "p", text: chapter().paragraphs[0] }];
    });
    const totalPages = createMemo(() => paged()?.pages.length ?? 0);
    const book = () => ({ chapters });
    const jobs = [];
    let finish;
    const dependencies = {
      createComputed, createEffect, createMemo, createSignal, on, onCleanup, untrack,
      isPaged: () => true, chapter, chapterCid, units, totalPages, paged, setPaged,
      chapterIdx, setChapterIdx, pageIdx, setPageIdx, pageColumns: () => columns, spreadStart,
      book, renderBook: book, setViewOffset: () => {}, resumeTarget, setResumeTarget,
      mirror: () => ({ text: chapter().paragraphs[0], unitStart: [0] }),
      pageTopOffsets: () => paged()?.pages.map((_, index) => index * 100) ?? [],
      isFirstChapter: () => chapterIdx() === 0, isLastChapter: () => chapterIdx() === 2,
      layout: () => ({}), imageLayoutTick: () => 0, chapterAuthor: () => null,
      disarmPagedBusy: () => {}, armPagedBusy: () => {}, unitImages: () => [],
      ensureImageSizes: async () => {},
      startChapterPagination: src => {
        const job = { cid: src.cid, cancelled: false };
        job.promise = new Promise(resolve => { job.resolve = resolve; });
        job.cancel = () => { job.cancelled = true; job.resolve(null); };
        jobs.push(job);
        return job;
      },
      cancelFollowIfActive: () => {}, armFollowPageCheck: () => {}, resetPageTurn: () => {},
      beginPageDrag: () => animated, setPagePreviewIndex: () => {},
      pageTurn: { active: () => false, finish: (_commit, callback) => { finish = callback; } },
      effectiveTranslationSettings: () => ({ enabled: translated, mode: "bilingual", pretranslate: 0 }),
      fingerprint: JSON.stringify, translationBookState: () => ({}), translationCacheVersion: () => 0,
      ensureTranslationSettings: async () => {}, ensureTranslationBook: async () => {},
      chapterUnits: ch => ch.paragraphs.map(text => ({ kind: "p", text })),
      bookTerms: async () => ({}), translationKey: text => text,
      translatedTexts: async (_id, _ch, texts, _config, _terms, signal, callback) => {
        signal.throwIfAborted();
        callback?.(Object.fromEntries(texts.map(text => [text, "译文"])));
      },
      reportFailure: (_message, error) => { throw error; }, t: key => key,
    };
    const actions = new Function(...Object.keys(dependencies), outputText)(...Object.values(dependencies));
    state = {
      ...actions, chapterIdx, pageIdx, resumeTarget, totalPages,
      refreshContent: () => setContentVersion(value => value + 1),
      flip: dir => { actions.userFlip(dir); finish?.(); finish = undefined; },
      settle: async count => {
        await drain();
        const job = jobs.findLast(job => !job.cancelled && job.cid === chapter().cid);
        assert.ok(job, "当前章必须有未取消的分页任务");
        job.resolve(pagesOf(count));
        await drain();
      },
    };
    return cleanup;
  });
  return { ...state, dispose };
}

for (const columns of [1, 2]) {
  for (const animated of [false, true]) {
    for (const translated of [false, true]) {
      for (const count of [1, 2, 5, 6, 9]) {
        const s = scenario({ columns, animated, translated });
        await s.settle(5); // 同页数 / 更短 / 更长的上一章均需正确落位。
        s.flip(-1);
        await drain();
        assert.equal(s.chapterIdx(), 1);
        assert.equal(s.totalPages(), 0, "目标章排版未就绪时等待");
        s.refreshContent(); // 模拟在线正文抵达，再触发译文状态重置与重新分页。
        await drain();
        assert.equal(s.resumeTarget(), null, "等待回翻末页时不能采样临时章首作为恢复目标");
        await s.settle(count);
        assert.equal(s.pageIdx(), spreadStart(count - 1, columns), "必须落到包含末页的最后一屏");
        s.flip(1);
        await s.settle(5);
        assert.equal(s.chapterIdx(), 2);
        assert.equal(s.pageIdx(), 0, "从上一章末屏向后翻页回到下一章首页");
        s.dispose();
      }
    }
  }

  const cancelled = scenario({ columns });
  await cancelled.settle(5);
  cancelled.flip(-1);
  await drain();
  cancelled.goToChapter(0);
  cancelled.goToChapter(1);
  await cancelled.settle(9);
  assert.equal(cancelled.pageIdx(), 0, "改跳其它章后再回原目标章，不能继承已取消的末页请求");
  cancelled.browseAdjacentChapter(-1);
  await cancelled.settle(6);
  assert.equal(cancelled.pageIdx(), 0, "工具栏上一章从章首开始");
  cancelled.flip(-1);
  assert.equal(cancelled.chapterIdx(), 0, "首章首页继续向前翻页不移动");
  assert.equal(cancelled.pageIdx(), 0);
  cancelled.dispose();
}
process.stdout.write("跨章翻页回归通过：译文开关、正文到达、异步分页、单双页、动画/直接翻页、页数变化、往返和取消\n");
