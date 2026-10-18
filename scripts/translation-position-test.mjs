import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// 执行 Reader 的实际采样、捕获和恢复函数，模拟浏览器光标命中与 DOM 重排。
const source = await readFile(new URL("../src/pages/Reader.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("Reader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText());
  ts.forEachChild(node, visit);
}
visit(ast);
const toggleSource = await readFile(new URL("../src/components/TranslationReadingToggle.tsx", import.meta.url), "utf8");
visit(ts.createSourceFile("TranslationReadingToggle.tsx", toggleSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
function load(name, dependencies) {
  assert.ok(functions.has(name), `缺少 Reader 函数 ${name}`);
  const { outputText } = ts.transpileModule(functions.get(name), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(...Object.keys(dependencies), `${outputText}\nreturn ${name};`)(...Object.values(dependencies));
}

for (const caretAPI of ["caretRangeFromPoint", "caretPositionFromPoint"]) {
  for (const translated of [false, true]) {
    const original = { dataset: { c: "0" }, hasAttribute: () => false };
    const translation = { dataset: { c: "0" }, hasAttribute: key => key === "data-translation" };
    const current = translated ? translation : original;
    let hit = { element: current };
    const restored = [];
    const root = {
      scrollTop: 100,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 390 }),
      contains: el => el === original || el === translation,
      querySelector: selector => selector.includes("data-translation") ? translation : original,
    };
    const mir = { text: "x".repeat(1000), unitStart: [0, 500] };
    const document = {
      [caretAPI]: () => caretAPI === "caretRangeFromPoint"
        ? { startContainer: hit, startOffset: 36 }
        : { offsetNode: hit, offset: 36 },
      createRange: () => ({
        setStart: node => restored.push(node), collapse: () => {},
        getBoundingClientRect: () => ({ top: 50, height: 20, width: 0 }),
      }),
    };
    const mirror = () => mir;
    const layout = () => ({ fontSize: 20, textWidth: 350 });
    const visiblePositionAtTop = load("visiblePositionAtTop", {
      mirror, layout, document, READING_LINE_HEIGHT: 1.95,
      readerTopPad: () => 20, flowWidth: () => 350,
      dataAnchorOf: node => ({ el: node.element, unit: 1, cstart: 0 }),
      charOffsetInElement: (_el, _node, offset) => offset,
    });
    assert.deepEqual(visiblePositionAtTop(root), { char: 536, translated });
    hit = { element: {} };
    assert.equal(visiblePositionAtTop(root), null, "忽略阅读容器外的光标命中");
    hit = { element: current };
    const captureReadingPos = load("captureReadingPos", {
      chapter: () => ({ cid: "chapter" }), chapterIdx: () => 2, mirror,
      isPaged: () => false, scrollRef: root, visiblePositionAtTop,
      viewOffset: () => 0,
    });
    const pos = captureReadingPos();
    assert.deepEqual(pos, { ci: 2, cid: "chapter", char: 536, translated });
    let pending = null;
    let resets = 0;
    const preserve = load("preserveTranslationPosition", {
      wantLastPageCid: null,
      chapter: () => ({ cid: "chapter" }), resumeTarget: () => pending,
      resetPageTurn: () => resets++, captureReadingPos,
      setResumeTarget: target => { pending = target; },
    });
    preserve();
    assert.deepEqual(pending, { cid: "chapter", char: 536, translated },
      "同段同时存在原文和译文时，恢复节点必须由实际命中决定");
    // 后续批次在旧恢复落定前继续到达，不得替换目标。
    hit = { element: translated ? original : translation };
    preserve();
    assert.equal(resets, 1);
    assert.equal(pending.translated, translated);
    const scrollToCharOffset = load("scrollToCharOffset", {
      mirror, layout, document, performance: { now: () => 0 },
      READING_LINE_HEIGHT: 1.95, readerTopPad: () => 20,
      unitAtGlobalOffset: (_mir, char) => ({ unit: char < 500 ? 0 : 1 }),
      charNodeAtOffset: (el, offset) => ({ node: el, offset }),
      suppressFollowCancelUntil: 0,
    });
    const applyResume = load("applyResume", {
      resumeTarget: () => pending, book: () => ({}), chapter: () => ({ cid: "chapter" }),
      mirror, isPaged: () => false, scrollRef: root, scrollToCharOffset,
      setResumeTarget: target => { pending = target; },
    });
    applyResume();
    assert.equal(pending, null);
    assert.equal(restored.at(-1), current, "重排后回到同一侧的节点");
    assert.equal(scrollToCharOffset(root, 536), true);
    assert.equal(restored.at(-1), original, "普通定位不继承上次恢复的译文状态");
    root.querySelector = () => original;
    scrollToCharOffset(root, 536, true);
    assert.equal(restored.at(-1), original, "隐藏译文后允许回退到原文");
  }
}

for (const translated of [false, true]) {
  const captureReadingPos = load("captureReadingPos", {
    chapter: () => ({ cid: "chapter" }), chapterIdx: () => 0,
    mirror: () => ({ text: "x".repeat(1000) }), isPaged: () => true,
    pageIdx: () => 1, pageTopOffsets: () => [0, 500],
    paged: () => ({ pages: [[], [{ kind: "img" }, { kind: "p", translated }]] }),
  });
  assert.equal(captureReadingPos().translated, translated, "分页保持当前页首正文的节点类型");
}

for (const readingText of ["translated", "original"]) {
  let busy = false;
  const writes = [];
  const toggle = load("toggleTranslationReading", {
    busy: () => busy,
    setBusy: value => { busy = value; },
    props: { readingText, onChange: async value => { writes.push(value); } },
  });
  const first = toggle();
  const second = toggle();
  assert.equal(busy, true);
  await Promise.all([first, second]);
  assert.equal(busy, false);
  assert.deepEqual(writes, [readingText === "translated" ? "original" : "translated"],
    "独立按钮只修改听书文本，且阻止重复提交");
}
let busy = false;
let failure;
const toggle = load("toggleTranslationReading", {
  busy: () => busy, setBusy: value => { busy = value; },
  props: { readingText: "original", onChange: async () => { throw new Error("save failed"); } },
  t: key => key, reportFailure: (message, error) => { failure = [message, error.message]; },
});
await toggle();
assert.deepEqual(failure, ["translation.saveFailed", "save failed"]);
assert.equal(busy, false, "保存失败后按钮可重试");
process.stdout.write("译文位置回归通过：实际节点采样、双语后续批次、两侧恢复、光标 API 回退、分页与独立切换\n");
