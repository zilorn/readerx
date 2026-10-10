import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createMemo, createRoot, createSignal, mapArray } from "../node_modules/solid-js/dist/solid.js";

// 执行 Reader 的实际屏窗口计算与每屏页列表，验证 Solid keyed 渲染保留图片所在的页。
const source = await readFile(new URL("../src/pages/Reader.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("Reader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let windowExpression;
let pagesExpression;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "mountedSpreads") {
    windowExpression = node.initializer.getText(ast);
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === "renderPagedSpread") {
    for (const statement of node.body.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(ast) === "visiblePages") pagesExpression = declaration.initializer.getText(ast);
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(windowExpression && pagesExpression, "必须有可复用的屏窗口与稳定页列表");
function expression(code, names) {
  const { outputText } = ts.transpileModule(`return ${code}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(...names, outputText);
}
const windowMemo = expression(windowExpression, ["createMemo", "isPaged", "totalPages", "snapPage", "pageIdx", "pageColumns"]);
const pagesMemo = expression(pagesExpression, ["createMemo", "paged", "first", "pageColumns"]);

for (const columns of [1, 2]) {
  let s;
  const dispose = createRoot((cleanup) => {
    const [pageIdx, setPageIdx] = createSignal(0);
    const [paged, setPaged] = createSignal({ pages: Array.from({ length: 9 }, () => [{}]) });
    const [isPaged, setIsPaged] = createSignal(true);
    const pageColumns = () => columns;
    const totalPages = () => paged().pages.length;
    const snapPage = (page) => Math.floor(page / columns) * columns;
    const mounted = windowMemo(createMemo, isPaged, totalPages, snapPage, pageIdx, pageColumns);
    let mounts = 0;
    const render = mapArray(mounted, (first) => {
      const pages = pagesMemo(createMemo, paged, first, pageColumns);
      // 对应两层 <For>：屏与页都按身份复用，token 代表该页的图片节点。
      const nodes = mapArray(pages, () => ({ token: ++mounts }));
      return { first, nodes };
    });
    s = { setPageIdx, setPaged, setIsPaged, mounted, render, mounts: () => mounts };
    return cleanup;
  });
  const at = (first) => s.render().find((spread) => spread.first === first);
  const original = at(0).nodes();
  const preview = at(columns).nodes();
  s.setPageIdx(columns);
  assert.equal(at(columns).nodes()[0], preview[0], "预览落页不能重新挂载图片所在的页");
  assert.equal(at(0).nodes()[0], original[0], "上一屏保留以便反向翻页");
  s.setPageIdx(0);
  assert.equal(at(0).nodes()[0], original[0], "回翻复用原屏");
  for (let first = columns; first < 9; first += columns) {
    const target = at(first).nodes();
    s.setPageIdx(first);
    assert.equal(at(first).nodes()[0], target[0], "快速连续翻页保留已挂载的目标图");
    assert.ok(s.render().length <= 3, "窗口不能保留整章 DOM");
    assert.ok(s.render().flatMap((spread) => spread.nodes()).length <= columns * 3);
  }
  assert.equal(at(8).nodes().length, 1, "双页末屏只挂载实际存在的页");
  const last = at(8).nodes()[0];
  s.setPaged({ pages: Array.from({ length: 9 }, () => [{}]) });
  assert.notEqual(at(8).nodes()[0], last, "换章或重排必须挂载新内容");
  s.setIsPaged(false);
  assert.deepEqual(s.render(), [], "切换滚动模式释放分页窗口");
  dispose();
}

// 可控动画时钟与最小 DOM：实际折页模块不克隆目标页，完成 / 打断只提交一次。
const turnSource = await readFile(new URL("../src/lib/readerPageTurn.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(turnSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { createReaderPageTurn } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
class Element {
  style = {};
  children = [];
  images = [];
  attributes = {};
  clientWidth = 400;
  clones = 0;
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((el) => el !== this);
    this.parentElement = null;
  }
  get firstElementChild() { return this.children[0]; }
  querySelectorAll(selector) { return selector === "img" ? this.images : []; }
  cloneNode() {
    this.clones++;
    const copy = new Element();
    copy.images = this.images.map((image) => ({ ...image }));
    return copy;
  }
}
const frames = new Map();
let nextFrame = 0;
let reduced = false;
globalThis.document = { createElement: () => new Element() };
globalThis.window = {
  requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
  cancelAnimationFrame: (id) => frames.delete(id),
  matchMedia: () => ({ matches: reduced }),
};
function tick() {
  for (const [id, callback] of [...frames]) {
    frames.delete(id);
    callback(performance.now() + 1000);
  }
}
const host = new Element();
const current = new Element();
current.images = [{ loading: "lazy", decoding: "async" }];
const preview = new Element();
host.append(current, preview);
const turn = createReaderPageTurn();
let commits = 0;
for (const dir of [1, -1]) {
  assert.ok(turn.begin(current, preview, dir));
  assert.equal(preview.clones, 0, "动画底页必须使用真实目标 DOM");
  const overlay = host.children.at(-1);
  assert.equal(overlay.style.background, "transparent");
  const front = overlay.children[0].firstElementChild;
  assert.equal(front.images[0].loading, "eager");
  assert.equal(front.images[0].decoding, "sync");
  turn.draw(0.4);
  turn.finish(true, () => commits++);
  assert.equal(turn.interrupt(), true);
  assert.equal(turn.interrupt(), false);
  tick();
  assert.equal(turn.active(), false);
}
assert.equal(commits, 2, "打断动画只提交一次");
turn.begin(current, preview, 1);
turn.finish(false, () => commits++);
tick();
assert.equal(commits, 3, "回弹执行清理回调");
assert.equal(turn.active(), false);
reduced = true;
turn.begin(current, preview, 1);
turn.finish(true, () => commits++);
tick();
assert.equal(commits, 4, "减少动态效果仍能完成落页");
turn.begin(current, undefined, 1);
assert.equal(host.children.at(-1).style.background, "var(--bg)", "跨章没有目标屏时保留纸张底色");
turn.finish(true, () => commits++);
turn.cancel();
tick();
assert.equal(commits, 4, "重排或卸载取消不能提交旧翻页");
assert.equal(frames.size, 0);
assert.equal(host.children.length, 2, "清理释放覆盖层");
process.stdout.write("翻页回归检查通过：图片页身份复用、单双页、末屏、窗口释放、完成/打断/回弹、减少动态效果和跨章取消\n");
