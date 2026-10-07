import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { batch, createEffect, createRoot, createSignal, on } from "../node_modules/solid-js/dist/solid.js";

// 执行 Reader 的实际恢复判定、翻页入口和跟随 effect；Solid 浏览器运行时保留同步更新时序。
const source = await readFile(new URL("../src/pages/Reader.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("Reader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
let pending, timer, followEffect, pageEffect, selectionEffect;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isVariableStatement(node)) {
    if (node.getText(ast).includes("followPageCheckPending")) pending = node.getText(ast);
    if (node.getText(ast).startsWith("let ttsFollowTimer")) timer = node.getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "createEffect") {
    const text = node.getText(ast);
    if (text.includes("window.clearInterval(ttsFollowTimer)")) followEffect = text;
    if (text.includes("() => checkFollowPage()")) pageEffect = text;
    if (text.includes("on(selSpan,")) selectionEffect = text;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
for (const text of [pending, timer, followEffect, pageEffect, selectionEffect]) assert.ok(text);
const names = ["cancelFollowIfActive", "pageIndexOfChar", "snapPage", "speakPageIndex",
  "speakOnCurrentScreen", "armFollowPageCheck", "checkFollowPage", "ensureSpeakVisible",
  "turnPage", "userFlip", "seekToPage"];
for (const name of names) assert.ok(functions.has(name), `缺少 Reader.${name}`);
const { outputText } = ts.transpileModule([
  pending, timer, "let wantLastPageCid = null;", ...names.map((name) => functions.get(name)),
  followEffect, pageEffect, selectionEffect,
  "return { turnPage, userFlip, seekToPage, armFollowPageCheck };",
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });

const pages = { pages: Array.from({ length: 8 }, (_, i) => [
  { kind: "p", unit: 0, cstart: i * 100, text: "字".repeat(100) },
]) };
const chapters = [{ cid: "a" }, { cid: "b" }];
const focusAt = (page, ci = 0) => ({ cid: chapters[ci].cid, chapterIndex: ci, item: { start: page * 100 } });

function scenario({ columns = 1, animated = true } = {}) {
  let state;
  const dispose = createRoot((cleanup) => {
    const [isPaged, setMode] = createSignal(true);
    const [paged, setPaged] = createSignal(pages);
    const [pageIdx, setPageIdx] = createSignal(0);
    const [pageColumns, setColumns] = createSignal(columns);
    const [chapterIdx, setChapterIdx] = createSignal(0);
    const [followEnabled, setFollowEnabled] = createSignal(true);
    const [selSpan, setSelSpan] = createSignal(null);
    const [focus, setFocus] = createSignal(focusAt(0));
    const [status, setStatus] = createSignal("playing");
    const intervals = new Map();
    let nextInterval = 0, finish;
    const dependencies = {
      createSignal, createEffect, on, isPaged, paged, pageIdx, setPageIdx, pageColumns,
      chapterIdx, chapter: () => chapters[chapterIdx()],
      mirror: () => ({ text: "字".repeat(800), unitStart: [0] }),
      totalPages: () => paged()?.pages.length ?? 0,
      spreadStart: (page, count) => Math.floor(page / count) * count,
      followEnabled, setFollowEnabled, selSpan,
      ttsPlayer: { focus, status }, ttsActive: () => status() !== "stopped",
      window: {
        clearInterval: (id) => intervals.delete(id),
        setInterval: (fn) => { intervals.set(++nextInterval, fn); return nextInterval; },
      },
      scrollRef: null, scrollToCharOffset: () => true,
      isLastChapter: () => chapterIdx() === chapters.length - 1,
      isFirstChapter: () => chapterIdx() === 0,
      renderBook: () => ({ chapters }),
      goToChapter: (ci) => batch(() => { setPaged(null); setChapterIdx(ci); setPageIdx(0); }),
      pageTurn: { active: () => false, finish: (_commit, fn) => { finish = fn; } },
      beginPageDrag: () => animated, setPagePreviewIndex: () => {}, offerJumpBack: () => {},
    };
    const actions = new Function(...Object.keys(dependencies), outputText)(...Object.values(dependencies));
    state = {
      ...actions, setMode, setPaged, setPageIdx, setColumns, setFocus, setStatus,
      followEnabled, pageIdx, setFollowEnabled, setSelSpan,
      select: () => { setFollowEnabled(false); setSelSpan([0, 10]); },
      clearSelection: () => setSelSpan(null),
      finishTurn: () => { const fn = finish; finish = undefined; fn?.(); },
      tick: () => { for (const fn of [...intervals.values()]) fn(); },
    };
    return cleanup;
  });
  return { ...state, dispose };
}

// Issue #2：选取期间语音跨屏，取消选中时不在跟读页；翻页落定后才置位恢复检查。
for (const columns of [1, 2]) {
  for (const animated of [false, true]) {
    const s = scenario({ columns, animated });
    s.select();
    s.setFocus(focusAt(columns));
    s.clearSelection();
    assert.equal(s.followEnabled(), false, "取消选中时不在跟读页，继续取消跟随");
    s.userFlip(1);
    if (animated) {
      assert.equal(s.pageIdx(), 0, "动画落定前视图仍在旧屏");
      s.finishTurn();
    }
    assert.equal(s.pageIdx(), columns);
    assert.equal(s.followEnabled(), true, "手动翻回跟读页后必须自动恢复，无需后续事件");
    s.setFocus(focusAt(columns * 2));
    assert.equal(s.pageIdx(), columns * 2, "恢复后下一句跨屏继续自动翻页");
    s.dispose();
  }
}

for (const columns of [1, 2]) {
  // 从朗读屏之后回翻；双页模式朗读句在右页也算回到跟读屏。
  const back = scenario({ columns });
  back.setFollowEnabled(false);
  back.setPageIdx(columns * 2);
  back.setFocus(focusAt(columns * 2 - 1));
  back.userFlip(-1);
  back.finishTurn();
  assert.equal(back.pageIdx(), columns);
  assert.equal(back.followEnabled(), true, "回翻到含朗读句的整屏恢复跟随");
  back.dispose();

  const seek = scenario({ columns });
  seek.select();
  seek.setFocus(focusAt(columns));
  seek.clearSelection();
  seek.seekToPage(columns);
  assert.equal(seek.followEnabled(), true, "进度条跳页在更新页码后置位也能恢复");
  seek.dispose();

  const selected = scenario({ columns });
  selected.select();
  selected.setFocus(focusAt(columns));
  selected.userFlip(1);
  selected.finishTurn();
  assert.equal(selected.followEnabled(), false, "选区仍存在时回到跟读页不能抢走选区");
  selected.clearSelection();
  assert.equal(selected.followEnabled(), true, "取消选中时已在跟读页立即恢复");
  selected.dispose();
}

const samePage = scenario();
samePage.select();
samePage.clearSelection();
assert.equal(samePage.followEnabled(), true, "没有跨页时取消选中也恢复");
samePage.dispose();

const browsing = scenario();
browsing.select();
browsing.setFocus(focusAt(2));
browsing.clearSelection();
browsing.userFlip(1);
browsing.finishTurn();
assert.equal(browsing.followEnabled(), false, "翻到其它屏继续取消跟随");
browsing.setFocus(focusAt(1));
browsing.tick();
assert.equal(browsing.followEnabled(), false, "朗读同章推进不能自行撤销手动取消");
browsing.setFocus(focusAt(3));
browsing.tick();
assert.equal(browsing.pageIdx(), 1, "取消跟读后的轮询不能拉走手动位置");
browsing.dispose();

const repaginating = scenario();
repaginating.setFollowEnabled(false);
repaginating.setPaged(null);
repaginating.setFocus(focusAt(3));
repaginating.armFollowPageCheck();
assert.equal(repaginating.followEnabled(), false);
// 等待期间朗读句继续推进，分页就绪时按最新朗读位置判定。
repaginating.setFocus(focusAt(4));
batch(() => { repaginating.setPageIdx(4); repaginating.setPaged(pages); });
assert.equal(repaginating.followEnabled(), true, "分页未就绪时保留挂起检查");
repaginating.dispose();

const crossChapter = scenario();
crossChapter.select();
crossChapter.setFocus(focusAt(0, 1));
crossChapter.clearSelection();
crossChapter.seekToPage(7);
assert.equal(crossChapter.followEnabled(), false, "不同章节不能仅凭相同页码恢复");
crossChapter.userFlip(1);
crossChapter.finishTurn();
assert.equal(crossChapter.followEnabled(), false, "跨章翻页等待新章分页");
crossChapter.setPaged(pages);
assert.equal(crossChapter.followEnabled(), true, "跨章落回朗读章首页后恢复");
crossChapter.dispose();

for (const status of ["playing", "paused", "loading"]) {
  const s = scenario();
  s.setStatus(status);
  s.select();
  s.clearSelection();
  assert.equal(s.followEnabled(), true, `${status} 状态允许在跟读页恢复`);
  s.dispose();
}

const stopped = scenario();
stopped.setStatus("stopped");
stopped.setFollowEnabled(false);
stopped.armFollowPageCheck();
assert.equal(stopped.followEnabled(), false, "已停止时不执行跟读页恢复");
stopped.dispose();

const scroll = scenario();
scroll.setMode(false);
scroll.select();
scroll.clearSelection();
assert.equal(scroll.followEnabled(), false, "滚动模式不参与跟读页自动恢复");
scroll.dispose();

const changedMode = scenario();
changedMode.setFollowEnabled(false);
changedMode.setPaged(null);
changedMode.armFollowPageCheck();
changedMode.setMode(false);
batch(() => { changedMode.setMode(true); changedMode.setPaged(pages); });
assert.equal(changedMode.followEnabled(), false, "切换滚动模式清除旧分页判定");
changedMode.dispose();

const title = scenario();
title.select();
title.setFocus({ ...focusAt(0), item: { start: -1 } });
title.clearSelection();
assert.equal(title.followEnabled(), false, "章节标题无正文页，不执行自动恢复");
title.dispose();

process.stdout.write("跟读恢复检查通过：选取跨屏、同步/动画翻页、单双页、进度跳页、重排/跨章等待与取消跟读边界\n");
