import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function load(path, deps) {
  const code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => {
    assert.ok(name in deps, `Unexpected import ${name}`);
    return deps[name];
  }, exports);
  return exports;
}
const { splitText, chapterRuleList } = await load("../src/lib/chapterRules.ts", {
  "solid-js": { createSignal: (value) => [() => value, (next) => { value = next; }] },
  "./backend": {}, "./dataIds": {},
  "./i18n": { t: (key, args) => `${key}${args ? JSON.stringify(args) : ""}` },
});
const { bookToMeta } = await load("../src/lib/booksTypes.ts", {});
const body = "正文不会串卷，章节顺序不变。".repeat(10);
const text = `内容简介\n${body}\n\n第一卷 初遇\n卷首文字\n第一章 开始\n短章\n第二章 相遇\n${body}\n\n第二卷 重逢\n第一章 归来\n${body}\n第二章 结局\n${body}`;
const result = splitText(text);
assert.equal(result.mode, "regex");
assert.equal(result.chapters.length, 6, "简介、卷首文字和四个章节各自保留");
assert.equal(result.chapters[0].volume, undefined);
assert.equal(result.chapters[0].title, "内容简介");
assert.equal(result.chapters[1].volume, "第一卷 初遇");
assert.deepEqual(result.chapters[1].paragraphs, ["卷首文字"]);
assert.equal(result.chapters[2].title, "第一章 开始");
assert.deepEqual(result.chapters[2].paragraphs, ["短章"]);
assert.deepEqual(result.chapters.map((c) => c.volume), [undefined, "第一卷 初遇", "第一卷 初遇", "第一卷 初遇", "第二卷 重逢", "第二卷 重逢"]);
assert.ok(result.chapters.every((c) => c.paragraphs.every((p) => !p.includes("第二卷 重逢"))), "卷标题不混入正文");
const meta = bookToMeta({ chapters: result.chapters.map((c, i) => ({ ...c, cid: `c${i}` })) });
assert.deepEqual(meta.chapters.map((c) => c.volume), result.chapters.map((c) => c.volume));
assert.equal(meta.chapters[2].chars, 2);

for (const [first, second] of [["上卷 初遇", "下卷 结局"], ["第一部 初遇", "第二部 结局"], ["Volume I: Start", "VOLUME II: End"], ["Book 1", "Part 2"]]) {
  const en = first.startsWith("V") || first.startsWith("Book");
  const heading = en ? "Chapter 1" : "第一章";
  const chapters = splitText(`\uFEFF${first}\r\n${heading}\r\n${body}\r\n${second}\r\n${heading}\r\n${body}`).chapters;
  assert.deepEqual(chapters.map((c) => c.volume), [first, second]);
  assert.deepEqual(chapters.map((c) => c.title), [heading, heading], "每卷可重新从第一章编号");
}
const single = splitText(`第一卷\n第一章\n一段\n第二章\n另一段`).chapters;
assert.equal(single.length, 2, "单卷和短章也能保留标题");
assert.ok(single.every((c) => c.volume === "第一卷"));
const ordinary = splitText(`第一章\n${body}\n第二章\n${body}`).chapters;
assert.equal(ordinary.length, 2);
assert.ok(ordinary.every((c) => c.volume === undefined), "旧平面目录保持不变");
const volumeOnly = splitText(`第一卷\n${body}\n第二卷\n${body}`).chapters;
assert.deepEqual(volumeOnly.map((c) => c.title), ["第一卷", "第二卷"], "只有卷标题仍可分章");
assert.deepEqual(splitText(`Volume I\n${body}\nVolume II\n${body}`).chapters.map((c) => c.title), ["Volume I", "Volume II"]);
const custom = { id: "custom", name: "Custom", pattern: "^Section [0-9]+[^\\n]*", builtin: false };
const customized = splitText(`第一卷\nSection 1\n${body}\n第二卷\nSection 2\n${body}`, [custom]);
assert.deepEqual(customized.chapters.map((c) => c.volume), ["第一卷", "第二卷"]);
const invalid = splitText(`第一卷\nSection 1\n${body}`, [{ ...custom, pattern: "[" }]);
assert.equal(invalid.mode, "chars");
const explicitVolume = splitText(`第一卷\n第一章\n${body}\n第二卷\n第二章\n${body}`, chapterRuleList().filter((r) => r.id === "builtin-zh-volume"));
assert.deepEqual(explicitVolume.chapters.map((c) => c.title), ["第一卷", "第二卷"]);
const prose = splitText(`第一章\n${body}\n我在第一卷里读过这些故事。\n第二章\n${body}`).chapters;
assert.ok(prose.every((c) => c.volume === undefined), "正文提及卷名不视为卷标题");
console.log("TXT volumes: 分卷、卷首、短章、重复章号、中英文、BOM/CRLF、自定义规则、平面兼容与元数据通过");
