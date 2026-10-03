import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

assert.equal(typeof globalThis.gc, "function", "请用 node --expose-gc 运行此检查");

function moduleUrl(source) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
}

const typesSource = await readFile(new URL("../src/lib/booksTypes.ts", import.meta.url), "utf8");
const progressSource = await readFile(new URL("../src/lib/progress.ts", import.meta.url), "utf8");
// 只加载字符统计与百分比计算，避免引入依赖 WebView 的书签和分页模块。
const percentSource = progressSource.slice(0, progressSource.indexOf("function occurrencesOf"))
  .replace(/^import .*from "\.\/bookmarks";\n/m, "")
  .replace(/^import .*from "\.\/pagination";\n/m, "")
  .replaceAll('"./booksTypes"', JSON.stringify(moduleUrl(typesSource)));
const { readingPercent } = await import(moduleUrl(percentSource));

function bookWithLengths(id, lengths) {
  return {
    id,
    chapters: lengths.map((length, i) => ({
      cid: `chapter-${i}`, title: `第 ${i + 1} 章`, paragraphs: ["文".repeat(length)],
    })),
  };
}

const original = bookWithLengths("same-id", [10, 30]);
const display = bookWithLengths("same-id", [30, 10]);
const replacement = bookWithLengths("same-id", [20, 20]);
assert.equal(readingPercent(original, 1, 0), 25);
assert.equal(readingPercent(display, 1, 0), 75);
assert.equal(readingPercent(replacement, 1, 0), 50);
assert.equal(readingPercent(original, 1, 0), 25);
assert.equal(readingPercent(display, 1, 0), 75);
assert.equal(readingPercent(original, 1, 999), 100);
assert.equal(readingPercent(original, 0, -1), 0);
assert.equal(readingPercent(bookWithLengths("empty", []), 0, 0), 0);

// 保持进度模块存活，释放调用方引用后确认整书对象可被 GC 回收。
function cacheTemporaryBooks() {
  return Array.from({ length: 20 }, (_, i) => {
    const book = bookWithLengths(`temporary-${i}`, [100_000, 200_000]);
    assert.equal(readingPercent(book, 1, 50_000), 50);
    return new WeakRef(book);
  });
}
const refs = cacheTemporaryBooks();
let collected = false;
for (let attempt = 0; attempt < 20; attempt++) {
  // WeakRef 在当前任务中保护目标；切换任务后才允许回收。
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.gc();
  if (refs.every((ref) => ref.deref() === undefined)) {
    collected = true;
    break;
  }
}
assert.ok(collected, "进度缓存不应强引用已经释放的整书对象");
process.stdout.write("进度缓存检查通过：同 ID 副本、正文替换、边界百分比及整书对象回收\n");
