import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createRoot, createSignal } from "../node_modules/solid-js/dist/solid.js";

// 使用 Solid 浏览器运行时和可控时钟，验证计时器真实的响应式清理行为。
const solidUrl = new URL("../node_modules/solid-js/dist/solid.js", import.meta.url).href;
const source = await readFile(new URL("../src/lib/readerAutoPage.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source.replace('"solid-js"', JSON.stringify(solidUrl)), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { createReaderAutoPage } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

let now = 0;
let nextId = 0;
const timers = new Map();
let selection = false;
globalThis.document = Object.assign(new EventTarget(), { hidden: false });
globalThis.window = Object.assign(new EventTarget(), {
  getSelection: () => ({ isCollapsed: !selection, toString: () => selection ? "selected" : "" }),
  setTimeout: (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, at: now + delay });
    return id;
  },
  clearTimeout: (id) => timers.delete(id),
});
function advanceTime(ms) {
  const end = now + ms;
  while (true) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > end) break;
    now = next[1].at;
    timers.delete(next[0]);
    next[1].callback();
  }
  now = end;
}

const [enabled, setEnabled] = createSignal(false);
const [ready, setReady] = createSignal(true);
const [interval, setInterval] = createSignal(5);
const [position, setPosition] = createSignal(0);
let turns = 0;
let ended = 0;
let atEnd = false;
const dispose = createRoot((cleanup) => {
  createReaderAutoPage({
    enabled, ready, interval, position,
    advance: () => { turns++; return !atEnd; },
    onEnd: () => { ended++; setEnabled(false); },
  });
  return cleanup;
});
advanceTime(10_000);
assert.equal(turns, 0);
setEnabled(true);
advanceTime(4_999);
assert.equal(turns, 0);
advanceTime(1);
assert.equal(turns, 1);
advanceTime(5_000);
assert.equal(turns, 2); // 同一章节连续翻页 / 滚动能够持续计时

setReady(false); // 菜单、下载和听书等门闩共用这一条件
advanceTime(60_000);
assert.equal(turns, 2);
setReady(true);
advanceTime(4_000);
setPosition(1); // 手动翻页和跨章重新完整计时
advanceTime(4_999);
assert.equal(turns, 2);
advanceTime(1);
assert.equal(turns, 3);

document.hidden = true;
document.dispatchEvent(new Event("visibilitychange"));
advanceTime(60_000);
assert.equal(turns, 3);
document.hidden = false;
document.dispatchEvent(new Event("visibilitychange"));
advanceTime(4_999);
assert.equal(turns, 3);
advanceTime(1);
assert.equal(turns, 4); // 恢复前台不补翻
window.dispatchEvent(new Event("blur"));
advanceTime(10_000);
assert.equal(turns, 4);
window.dispatchEvent(new Event("focus"));
selection = true;
document.dispatchEvent(new Event("selectionchange"));
advanceTime(10_000);
assert.equal(turns, 4);
selection = false;
document.dispatchEvent(new Event("selectionchange"));
setInterval(10);
advanceTime(9_999);
assert.equal(turns, 4);
advanceTime(1);
assert.equal(turns, 5);

atEnd = true;
advanceTime(10_000);
assert.equal(ended, 1);
assert.equal(enabled(), false);
advanceTime(30_000);
assert.equal(turns, 6);
setEnabled(true);
dispose();
assert.equal(timers.size, 0);
advanceTime(30_000);
assert.equal(turns, 6);
process.stdout.write("自动翻页计时检查通过：连续翻页、暂停恢复、位置/间隔变化、后台/失焦/选区、书末和卸载清理\n");
