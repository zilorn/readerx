import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// 分句器是纯函数；截取该部分，避免加载依赖 WebView 的章节模块。
const source = await readFile(new URL("../src/lib/ttsSegment.ts", import.meta.url), "utf8");
const splitter = source.slice(source.indexOf("const END_CHARS"), source.indexOf("export function buildChapterSpeechItems"));
const selectionSource = await readFile(new URL("../src/lib/textSelection.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(splitter + selectionSource.replace(/^import .*;\n/m, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { splitSpeechLocal, splitSpeechItemsAtPages, sentenceSelectionRange } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const cases = [
  ["他说：“第一句。第二句！第三句？”然后离开。", ["他说：“第一句。", "第二句！", "第三句？”", "然后离开。"]],
  ["「第一句。第二句。」『第三句？第四句！』", ["「第一句。", "第二句。」", "『第三句？", "第四句！』"]],
  ["“外层「内层。还有一句！」继续。”", ["“外层「内层。", "还有一句！」", "继续。”"]],
  ['"First. Second!" "Third?"', ['"First.', 'Second!"', '"Third?"']],
  ["（第一句。第二句。）下一句。", ["（第一句。", "第二句。）", "下一句。"]],
  ["“未闭合。仍然切句。", ["“未闭合。", "仍然切句。"]],
  ["“你好？！”  下一句……结束。", ["“你好？！”", "下一句……", "结束。"]],
  ["数值3.14，域名example.com。正常结束。", ["数值3.14，域名example.com。", "正常结束。"]],
  ["……「」！？  ", []],
  ["  普通一句。\n 下一句！  ", ["普通一句。", "下一句！"]],
];
const sentences = Array.from({ length: 15 }, (_, i) => `第${i + 1}句。`);
cases.push([`“${sentences.join("")}”`, sentences.map((s, i) => `${i === 0 ? "“" : ""}${s}${i === 14 ? "”" : ""}`)]);
cases.push(["甲".repeat(700), ["甲".repeat(320), "甲".repeat(320), "甲".repeat(60)]]);

for (const [text, expected] of cases) {
  const ranges = splitSpeechLocal(text);
  assert.deepEqual(ranges.map((range) => range.text), expected, text);
  let previousEnd = 0;
  for (const range of ranges) {
    assert.ok(range.s >= previousEnd);
    assert.equal(text.slice(range.s, range.e), range.text);
    previousEnd = range.e;
  }
}
process.stdout.write(`TTS 分句回归检查通过（${cases.length} 组）\n`);

const title = { unit: -1, ls: 0, le: 0, start: -1, end: -1, isTitle: true, text: "标题" };
const original = { unit: 2, ls: 3, le: 13, start: 20, end: 30, text: "甲乙丙丁。戊己庚辛。" };
const split = splitSpeechItemsAtPages([title, original], [27, 22, 22, 20, 30, NaN]);
assert.equal(split[0], title);
assert.deepEqual(split.slice(1).map(({ text, start, end, ls, le }) => ({ text, start, end, ls, le })), [
  { text: "甲乙", start: 20, end: 22, ls: 3, le: 5 },
  { text: "丙丁。戊己", start: 22, end: 27, ls: 5, le: 10 },
  { text: "庚辛。", start: 27, end: 30, ls: 10, le: 13 },
]);
assert.deepEqual(splitSpeechItemsAtPages([original], []), [original]);
assert.equal(split.slice(1).map((item) => item.text).join(""), original.text);
process.stdout.write("TTS 页边界与偏移回归检查通过\n");

// 长按须沿用完整段落的分句结果，再裁到被按下的那一页，不能重新对页内碎片分句。
for (const [text] of cases) {
  for (const sentence of splitSpeechLocal(text)) {
    for (let offset = sentence.s; offset < sentence.e; offset++) {
      assert.deepEqual(sentenceSelectionRange(text, offset, 0, text.length), [sentence.s, sentence.e]);
      const cut = Math.floor((sentence.s + sentence.e) / 2);
      const page = offset < cut ? [0, cut] : [cut, text.length];
      assert.deepEqual(sentenceSelectionRange(text, offset, ...page), [
        Math.max(sentence.s, page[0]), Math.min(sentence.e, page[1]),
      ]);
    }
  }
}
assert.deepEqual(sentenceSelectionRange("甲乙丙丁。", 2, 1, 4), [1, 4]);
// 页起点可以在前一个单元内，页终点也可以在后一个单元内。
assert.deepEqual(sentenceSelectionRange("第一句。第二句！", 5, -10, 20), [4, 8]);
assert.deepEqual(sentenceSelectionRange("  甲。", 0, 0, 4), [0, 1]);
assert.deepEqual(sentenceSelectionRange("😀！？", 0, 0, 4), [0, 2]);
assert.deepEqual(sentenceSelectionRange("😀！？", 1, 0, 4), [0, 2]);
assert.equal(sentenceSelectionRange("甲乙。", 2, 0, 2), null);
assert.equal(sentenceSelectionRange("甲乙。", 3, 0, 3), null);
process.stdout.write("长按分句选取与单页裁剪回归检查通过\n");
