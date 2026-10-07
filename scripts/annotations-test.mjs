import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createSignal } from "solid-js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// 执行实际注释状态模块，模拟磁盘延迟与读写失败，验证不会覆盖已有记录。
let disk = new Map();
let readFails = false;
let writeFails = false;
let pauseRead;
let reads = 0;
let writes = 0;
let failures = 0;
const bridge = {
  async readRemoteAnnotations(id) {
    reads++;
    if (pauseRead) await pauseRead;
    return readFails ? null : structuredClone(disk.get(id) ?? []);
  },
  async saveRemoteAnnotations(id, list) {
    writes++;
    if (writeFails) return false;
    disk.set(id, structuredClone(list));
    return true;
  },
};
const code = ts.transpileModule(await readFile(new URL("../src/lib/annotations.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
new Function("require", "exports", code)((name) => ({
  "solid-js": { createSignal },
  "@noble/hashes/sha2.js": { sha256 },
  "@noble/hashes/utils.js": { bytesToHex },
  "./backend": bridge,
  "./logger": { createLogger: () => ({ info() {} }) },
  "./errorReport": { reportFailure() { failures++; } },
  "./i18n": { t: (key) => key },
})[name], exports);
const { paragraphAnchor, resolveAnnotationUnit, annotationsFor, saveAnnotationNote, ensureAnnotationsLoaded, invalidateAnnotationCache } = exports;
const units = ["前段", "重复", "后一段", "重复", "结尾"].map((text) => ({ kind: "p", text }));
const anchor = paragraphAnchor("c1", units, 1);
assert.equal(resolveAnnotationUnit(anchor, units), 1);
assert.equal(resolveAnnotationUnit(anchor, [{ kind: "p", text: "新增" }, ...units]), 2, "重复原文通过邻段指纹定位");
assert.equal(resolveAnnotationUnit(anchor, [{ kind: "p", text: "重复" }, { kind: "p", text: "重复" }]), null, "歧义时不挂错段");
assert.equal(paragraphAnchor("c1", [{ kind: "h", text: "标题" }], 0), null);
assert.equal(paragraphAnchor("c1", [{ kind: "img", src: "image" }], 0), null);
assert.equal(paragraphAnchor("c1", [{ kind: "p", text: "" }], 0), null);

await Promise.all([saveAnnotationNote("b1", anchor, null, null, "第一条"), saveAnnotationNote("b1", anchor, null, null, "第二条")]);
assert.equal(reads, 1, "并发首次添加只读取一次");
assert.equal(disk.get("b1").length, 1, "同段只有一条聚合记录");
assert.equal(disk.get("b1")[0].notes.length, 2);
const paragraph = annotationsFor("b1")[0];
const note = paragraph.notes[0];
assert.ok(await saveAnnotationNote("b1", anchor, paragraph.id, note.id, "改写"));
assert.equal(disk.get("b1")[0].notes[0].id, note.id);
assert.equal(disk.get("b1")[0].notes[0].createdAt, note.createdAt);
assert.equal(disk.get("b1")[0].notes.length, 2);
await saveAnnotationNote("b2", anchor, null, null, "另一本书");
assert.equal(disk.get("b1")[0].notes.length, 2, "书籍隔离");
assert.equal(await saveAnnotationNote("b1", anchor, null, null, " "), false);
assert.equal(await saveAnnotationNote("b1", anchor, null, null, "字".repeat(2001)), false);

writeFails = true;
const old = structuredClone(annotationsFor("b1"));
assert.equal(await saveAnnotationNote("b1", anchor, paragraph.id, note.id, "写失败"), false);
assert.deepEqual(annotationsFor("b1"), old, "写失败保留内存与磁盘原记录");
writeFails = false;
assert.ok(await saveAnnotationNote("b1", anchor, paragraph.id, note.id, "重试成功"));
invalidateAnnotationCache();
readFails = true;
const written = writes;
assert.equal(await saveAnnotationNote("b1", anchor, null, null, "不能覆盖"), false);
assert.equal(writes, written, "读失败不调用写入");
readFails = false;
await ensureAnnotationsLoaded("b1");
assert.equal(annotationsFor("b1")[0].notes[0].text, "重试成功", "重新加载保留更新与多条注释");

invalidateAnnotationCache();
disk.set("bad", [{ id: "invalid" }]);
assert.equal(await ensureAnnotationsLoaded("bad"), false);
assert.equal(failures, 1, "非法记录不能作为可写的空列表");
let release;
pauseRead = new Promise((resolve) => { release = resolve; });
const stale = ensureAnnotationsLoaded("b1");
invalidateAnnotationCache("b1");
release();
assert.equal(await stale, false, "删除/恢复后，旧的在飞读取不能重新填回缓存");
pauseRead = null;
await ensureAnnotationsLoaded("b1");
assert.equal(annotationsFor("b1")[0].notes.length, 2);
console.log("annotations: 聚合、编辑、书籍隔离、锚点重定位、并发与失败保护通过");
