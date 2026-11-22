import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/shell/exitSnapshot.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { MAX_EXIT_SNAPSHOT_NODES, shouldSnapshot, leaveTargetsSamePath } = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(outputText)}`,
);

assert.equal(MAX_EXIT_SNAPSHOT_NODES, 1200);
assert.equal(shouldSnapshot(0), true);
assert.equal(shouldSnapshot(1200), true, "1200 个节点仍生成快照");
assert.equal(shouldSnapshot(1201), false, "1201 个节点直接切换");
assert.equal(shouldSnapshot(6000), false);

assert.equal(leaveTargetsSamePath("/discover?q=foo", "/discover"), true);
assert.equal(leaveTargetsSamePath("?q=foo", "/discover"), true);
assert.equal(leaveTargetsSamePath("#section", "/discover"), true);
assert.equal(leaveTargetsSamePath("/discover#section", "/discover"), true);
assert.equal(leaveTargetsSamePath("/book/1?x=1", "/book/1"), true);
assert.equal(leaveTargetsSamePath("/book/a%20b", "/book/a b"), true);
assert.equal(leaveTargetsSamePath("/book/1", "/discover"), false);
assert.equal(leaveTargetsSamePath("/discover/extra", "/discover"), false);
assert.equal(leaveTargetsSamePath("/discover?q=a", "/book/1"), false);
assert.equal(leaveTargetsSamePath(-1, "/discover"), false);
assert.equal(leaveTargetsSamePath(0, "/discover"), false);

console.log("exit snapshot decisions ok");
