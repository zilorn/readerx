import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// 分句器是纯函数；截取该部分，避免加载依赖 WebView 的章节模块。
const source = await readFile(new URL("../src/lib/ttsSegment.ts", import.meta.url), "utf8");
const splitter = source.slice(source.indexOf("const END_CHARS"), source.indexOf("export function buildChapterSpeechItems"));
const { outputText } = ts.transpileModule(splitter, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { splitSpeechLocal } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

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
