import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const positionSource = await readFile(new URL("../src/lib/selectionMenuPosition.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(positionSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { selectionMenuTop } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const handle = (y, x = 100) => ({ x, y, r: 12 });
const geometry = (overrides = {}) => ({
  top: 60, bottom: 120, firstLineTop: 60, pageTop: 40, lineHeight: 30,
  handles: [handle(90), handle(130)], ...overrides,
});
const place = (geo, height = 46, max = 740) => selectionMenuTop(geo, height, 14, max);

// 页顶含留白，第四行仍贴末手柄下方；第五行从起始手柄上方贴放。
for (const lineHeight of [24, 30, 48]) {
  const pageTop = 56;
  const fourth = pageTop + 3 * lineHeight + 2;
  const fifth = pageTop + 4 * lineHeight + 2;
  assert.equal(place(geometry({ top: fourth, firstLineTop: fourth, pageTop, lineHeight,
    bottom: fourth + 20, handles: [handle(fourth + 25)] })), fourth + 47);
  assert.equal(place(geometry({ top: fifth, firstLineTop: fifth, pageTop, lineHeight,
    bottom: fifth + 20, handles: [handle(fifth + 25)] })), fifth - 56);
}
assert.equal(place(geometry({ top: 160, firstLineTop: 160 })), 22, "四行阈值处不再贴下方，且避让起始手柄");
assert.equal(place(geometry()), 152, "下方与末手柄外缘间距为 10px");
assert.equal(place(geometry({ top: 250, firstLineTop: 250, bottom: 340,
  handles: [handle(280), handle(350)] })), 194, "上方与首行间距为 10px");
assert.equal(place(geometry({ handles: [handle(130)] })), 152, "跨屏只有末手柄可见");
assert.equal(place(geometry({ top: 250, firstLineTop: 250, bottom: 340,
  handles: [handle(280)] })), 194, "跨屏只有起始手柄可见");
assert.equal(place(geometry({ handles: [] })), 130, "两端在屏外时使用可见行盒");
assert.equal(place(geometry({ top: 250, firstLineTop: 250, bottom: 340, handles: [] }), 132), 108,
  "展开样式面板后保持上方方向，使用实测菜单高度");
assert.equal(place(geometry(), 132), 152, "展开面板后下方锚点不变");
assert.equal(place(geometry({ bottom: 790, handles: [handle(800)] })), 740,
  "空间不足夹取下安全区，不翻面");
assert.equal(place(geometry({ top: 150, firstLineTop: 170, handles: [] }), 180), 14,
  "上方放不下面板时夹取上安全区，不翻面");

// 执行 Reader 的实际行盒采样，覆盖双页阅读顺序及跨页可见范围。
const reader = await readFile(new URL("../src/pages/Reader.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("Reader.tsx", reader, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let layoutSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "pageSelLayout") layoutSource = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(layoutSource);
const layoutJs = ts.transpileModule(layoutSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const runLayout = new Function("selSpan", "areaRef", "colRef", "isPaged", "mirror", "visibleSpan",
  "caretRangeAtGlobalOffset", "glyphRangeAtGlobalOffset", "glyphRectOf", "layout",
  "GLYPH_BOX_MAX_EM", "READING_LINE_HEIGHT", `${layoutJs}; return pageSelLayout();`);
function sample(span, visible, firstTop, lastTop) {
  const rect = { top: 100, left: 0, width: 1000 };
  return runLayout(() => span, { getBoundingClientRect: () => rect },
    { getBoundingClientRect: () => ({ top: 140 }) }, () => true,
    () => ({ unitStart: [0] }), () => visible,
    () => ({ getBoundingClientRect: () => ({ width: 1, height: 20 }) }),
    (_col, _units, _off, fromStart) => ({ fromStart }),
    ({ fromStart }) => ({ top: 100 + (fromStart ? firstTop : lastTop),
      bottom: 120 + (fromStart ? firstTop : lastTop), left: 80, right: 100, width: 20, height: 20 }),
    () => ({ fontSize: 20 }), 1.5, 1.5);
}
const spread = sample([10, 90], [0, 100], 260, 60);
assert.equal(spread.pageTop, 40);
assert.equal(spread.lineHeight, 30);
assert.equal(spread.firstLineTop, 260, "双页首行来自左页起点，而不是更靠上的右页终点");
assert.equal(spread.top, 60, "可见避让范围仍包含右页的文字");
assert.equal(place(geometry({ ...spread, handles: [handle(spread.lo.y), handle(spread.hi.y)] })), 14,
  "双页首行不在顶部四行时保持上方规则并夹取安全区");
const trailing = sample([10, 90], [50, 100], 60, 180);
assert.equal(trailing.lo, null);
assert.ok(trailing.hi);
assert.equal(trailing.firstLineTop, 60, "跨页时使用夹取后的首个可见行");
const leading = sample([10, 90], [0, 50], 200, 320);
assert.ok(leading.lo);
assert.equal(leading.hi, null);
const middle = sample([10, 190], [50, 100], 60, 320);
assert.equal(middle.lo, null);
assert.equal(middle.hi, null);
assert.equal(middle.firstLineTop, 60);

console.log("selection-menu-position: 四行阈值、正文留白/字号、手柄间距、面板高度、安全区、双页/跨屏通过");
