import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 在隔离的最小项目中执行真实扫描器，不改变应用词典。
const root = await mkdtemp(join(tmpdir(), "readerx-i18n-check-"));
try {
  await mkdir(join(root, "scripts"));
  const locales = join(root, "src/lib/i18n/locales");
  for (const locale of ["zh-CN", "en"]) {
    await mkdir(join(locales, locale), { recursive: true });
    await writeFile(join(locales, locale, "fixture.ts"), `export const fixture = {
      "fixture.direct": "Direct",
      "fixture.label": "Label",
      "fixture.dead": "Dead",
      "translation.saved": "Saved",
      "fixture.count": "{count} items",
      ${locale === "en" ? '"fixture.count_one": "{count} item", "fixture.count_other": "{count} items",' : ""}
    };`);
  }
  await writeFile(join(locales, "zh-CN.ts"), 'export { fixture } from "./zh-CN/fixture";');
  await copyFile(new URL("./i18n-check.mjs", import.meta.url), join(root, "scripts/i18n-check.mjs"));
  const app = join(root, "src/app.ts");
  const source = `t("fixture.direct");
    const labels = { labelKey: "fixture.label" };
    t(labels.labelKey);
    t("fixture.count", { count: 2 });`;
  await writeFile(app, source);
  function check() {
    const result = spawnSync(process.execPath, [join(root, "scripts/i18n-check.mjs")], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return [...result.stdout.matchAll(/未被引用的 key：([^\s]+)/g)].map(match => match[1]);
  }
  assert.deepEqual(check(), ["fixture.dead", "translation.saved"], "词典定义不能自证引用，直接调用与 labelKey 应保留");
  await writeFile(app, source + '\nshowToast(t("translation.saved"));');
  assert.deepEqual(check(), ["fixture.dead"], "新增实际保存提示后仅剩真正未引用的 key");
  await writeFile(app, source.replace('t("fixture.direct");', ""));
  assert.deepEqual(check(), ["fixture.direct", "fixture.dead", "translation.saved"], "移除 UI 引用后必须重新报告");
  console.log("i18n scanner regression passed: locale exclusion, unused keys, UI references, label keys and plural variants");
} finally {
  await rm(root, { recursive: true, force: true });
}
