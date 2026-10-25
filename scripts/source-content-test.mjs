import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function load(name, deps) {
  const source = await readFile(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function("require", "exports", outputText)(name => {
    assert.ok(name in deps, name);
    return deps[name];
  }, exports);
  return exports;
}

// 这里验证解析器交给 DOM 的输入始终只有文本/实体；真实浏览器事件执行另做验证。
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, "textarea", "实体解码不能创建能加载资源的普通 HTML 容器");
    return {
      set innerHTML(value) {
        assert.ok(!value.includes("<"), "不应把原始标签交给 HTML 解析器");
        const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        this.value = value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity) => {
          if (!entity.startsWith("#")) return named[entity];
          return String.fromCodePoint(entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
        });
      },
      value: "",
    };
  },
};
const types = await load("booksTypes", {});
const { tokenizeSourceContent, buildSourceChapterContent } = await load("sourceContent", { "./booksTypes": types });
assert.deepEqual(tokenizeSourceContent('<img src="/image?a=1&amp;b=2" alt="&lt;图&gt; &#x4e2d;&#25991; &quot;引号&quot;">'), [
  { kind: "img", src: "/image?a=1&b=2", alt: '<图> 中文 "引号"' },
]);
for (const raw of [
  "<img src=x onerror='window.audit=1'>&amp;",
  "</textarea><img src=x onerror='window.audit=1'>&amp;",
  "<svg onload='window.audit=1'>&amp;</svg>",
]) {
  const tokens = tokenizeSourceContent(`<img src="/image" alt="${raw}">`);
  assert.equal(tokens[0].alt, raw.replace("&amp;", "&"), "恶意标记仅作为属性文本返回");
}
const build = buildSourceChapterContent('前文<img src="/image?a=1&amp;b=2">后文', "https://example.invalid/chapter/1");
assert.deepEqual(build.paragraphs, ["前文后文"]);
assert.equal(build.blocks[0].imgs[0].remote, "https://example.invalid/image?a=1&b=2");
assert.equal(build.blocks[0].imgs[0].at, 2);
console.log("source content: 属性实体、恶意标签隔离、图片地址与段内锚点通过");
