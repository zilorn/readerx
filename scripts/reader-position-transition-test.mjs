import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  batch, createComputed, createEffect, createRenderEffect, createRoot, createSignal, on,
} from "../node_modules/solid-js/dist/solid.js";

// 执行 Reader 中实际的切换计算，使用 Solid 浏览器运行时验证 DOM 卸载和进度提交顺序。
const source = await readFile(new URL("../src/pages/Reader.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("Reader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let transition;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "createComputed" &&
      node.getText(ast).includes("on([isPaged, pageColumns]")) transition = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(transition, "Reader 必须在渲染前同步捕获切换位置");
const { outputText } = ts.transpileModule(transition, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
});
const dependencies = ["createComputed", "on", "isPaged", "pageColumns", "chapter", "resumeTarget",
  "scrollRef", "visibleCharAtTop", "viewOffset", "setResumeTarget", "spreadStart", "pageIdx", "setPageIdx"];
const install = new Function(...dependencies, outputText);

function scenario({ paged = true, columns = 1, offset = 900, visible = 1200, pending = null } = {}) {
  let state;
  const dispose = createRoot((cleanup) => {
    const [isPaged, setPaged] = createSignal(paged);
    const [pageColumns, setColumns] = createSignal(columns);
    const [viewOffset, setOffset] = createSignal(offset);
    const [resumeTarget, setResumeTarget] = createSignal(pending);
    const [pageIdx, setPageIdx] = createSignal(paged && columns === 2 ? 2 : 3);
    const root = { isConnected: !paged };
    const writes = [];
    let sampled = 0;
    let viewport = visible;
    install(createComputed, on, isPaged, pageColumns, () => ({ cid: "chapter" }),
      resumeTarget, root, (el) => {
        assert.equal(el.isConnected, true, "必须在旧滚动 DOM 卸载前采样");
        sampled++;
        return viewport;
      }, viewOffset, setResumeTarget, (page, count) => Math.floor(page / count) * count,
      pageIdx, setPageIdx);
    // 模拟 JSX 的模式切换以及章首滚动容器挂载。
    createRenderEffect(on(isPaged, (mode) => {
      root.isConnected = !mode;
      if (!mode) viewport = 0;
    }, { defer: true }));
    createEffect(() => {
      if (resumeTarget()) return;
      const current = isPaged() ? pageIdx() * 300 : viewport;
      setOffset(current);
      writes.push(current);
    });
    state = {
      setPaged, setColumns, setOffset, setResumeTarget, resumeTarget, pageIdx,
      writes, sampled: () => sampled,
      scrollTo: (char) => { viewport = char; },
      settle: () => batch(() => {
        const target = resumeTarget();
        assert.ok(target);
        if (isPaged()) setPageIdx(Math.floor(target.char / 300 / pageColumns()) * pageColumns());
        else viewport = target.char;
        setResumeTarget(null);
      }),
    };
    return cleanup;
  });
  state.writes.length = 0;
  return { ...state, dispose };
}

for (const columns of [1, 2]) {
  const s = scenario({ columns });
  const startChar = columns === 1 ? 900 : 600;
  s.setPaged(false);
  assert.deepEqual(s.resumeTarget(), { cid: "chapter", char: startChar });
  assert.deepEqual(s.writes, [], "分页转滚动：恢复前不能提交章首");
  s.setColumns(columns === 1 ? 2 : 1);
  assert.equal(s.resumeTarget().char, startChar, "等待滚动分片挂载期间保留目标");
  s.settle();
  assert.deepEqual(s.writes, [startChar]);
  // 模拟用户滚动后尚未执行 requestAnimationFrame：已提交位置仍为上一视图的位置。
  s.scrollTo(1450);
  s.writes.length = 0;
  s.setPaged(true);
  assert.equal(s.sampled(), 1);
  assert.equal(s.resumeTarget().char, 1450);
  assert.deepEqual(s.writes, [], "滚动转分页：恢复前不能提交旧页码");
  s.settle();
  assert.equal(s.pageIdx(), 4);
  assert.deepEqual(s.writes, [1200], "落到包含目标字符的页 / 双页屏首");
  s.dispose();
}

const start = scenario({ paged: false, offset: 0, visible: 0 });
start.setPaged(true);
assert.equal(start.resumeTarget().char, 0, "滚动读回章首后不能沿用旧页码");
assert.deepEqual(start.writes, []);
start.settle();
assert.equal(start.pageIdx(), 0);
assert.deepEqual(start.writes, [0]);
start.dispose();

const quick = scenario();
quick.setPaged(false);
quick.setPaged(true);
quick.setPaged(false);
assert.equal(quick.resumeTarget().char, 900, "连续切换沿用尚未落定的目标");
assert.equal(quick.sampled(), 0);
assert.deepEqual(quick.writes, []);
quick.settle();
assert.deepEqual(quick.writes, [900]);
quick.dispose();

const fallback = scenario({ paged: false });
fallback.scrollTo(null); // 图片或空白区域无法采样文字时沿用最后提交的偏移。
fallback.setPaged(true);
assert.equal(fallback.resumeTarget().char, 1200);
assert.deepEqual(fallback.writes, []);
fallback.dispose();

const opening = scenario({ pending: { cid: "chapter", char: 2100 } });
opening.setPaged(false);
assert.equal(opening.resumeTarget().char, 2100, "打开书恢复途中切换保留存档目标");
assert.deepEqual(opening.writes, []);
opening.dispose();

const spread = scenario();
spread.setColumns(2);
assert.equal(spread.resumeTarget().char, 900);
spread.settle();
assert.equal(spread.pageIdx(), 2);
assert.deepEqual(spread.writes, [600]);
spread.dispose();

const scrolling = scenario({ paged: false });
scrolling.setColumns(2);
assert.equal(scrolling.resumeTarget(), null, "滚动模式改变宽度不强制恢复旧位置");
assert.equal(scrolling.sampled(), 0);
scrolling.dispose();
process.stdout.write("阅读位置切换检查通过：分页/滚动、单双页、未提交滚动、章首、连续切换和未落定恢复\n");
