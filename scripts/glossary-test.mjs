import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as solid from "../node_modules/solid-js/dist/solid.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

async function load(path, imports, transformers) {
  const source = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    transformers,
  });
  const exports = {};
  new Function("require", "exports", outputText)(name => {
    assert.ok(name in imports, name);
    return imports[name];
  }, exports);
  return exports;
}
const i18n = { t: key => key };
const types = await load("lib/translation/types.ts", {});
const core = await load("lib/translation/core.ts", {
  "@noble/hashes/sha2.js": { sha256 }, "@noble/hashes/utils.js": { bytesToHex },
});
const chinese = [{ source: "Alice", target: "爱丽丝", note: "" }];
const japanese = [{ source: "Alice", target: "アリス", note: "" }];
const book = { id: "glossary-book", chapters: [{ cid: "one", paragraphs: ["Alice entered the room."] }] };
let storedGlobal = { ...types.DEFAULT_TRANSLATION_SETTINGS, enabled: true, glossary: true, provider: "openai", model: "test" };
let storedBook = { overrides: {}, terms: chinese, glossaryTarget: "zh-CN" };
let writes = 0, requests = 0, payload = { terms: japanese }, pending;
const settings = await load("lib/translation/settings.ts", {
  "solid-js": solid, "./types": types,
  "../backend": {
    readTranslationSettings: async () => structuredClone(storedGlobal),
    putTranslationSettings: async value => { storedGlobal = structuredClone(value); },
    readTranslationBook: async () => structuredClone(storedBook),
    putTranslationBook: async (_id, value) => { writes++; storedBook = structuredClone(value); },
  },
});
const provider = await load("lib/translation/provider.ts", {
  "../i18n": i18n, "./core": core,
  "../http": { httpFetch: async (_url, init) => {
    requests++;
    if (pending) return pending(init);
    return response(payload);
  } },
});
function response(value) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
}
const engine = await load("lib/translation/engine.ts", {
  "solid-js": solid, "../i18n": i18n, "./core": core,
  "./provider": provider, "./settings": settings, "./sources": {},
  "../pagination": {}, "../backend": {},
});

// 只替换组件最外层的 JSX 返回值，执行实际初始化、草稿编辑、生成与保存函数。
const mounts = [], cleanups = [], failures = [];
const component = await load("components/GlossarySheet.tsx", {
  "solid-js": { ...solid, onMount: fn => mounts.push(fn), onCleanup: fn => cleanups.push(fn) },
  "./Drawer": {}, "./icons": {}, "../lib/i18n": i18n,
  "../lib/books": { ensureLocalBookContent: async () => book },
  "../lib/translation/settings": settings, "../lib/translation/engine": engine,
  "../lib/translation/core": core,
  "../lib/errorReport": { reportFailure: (...args) => failures.push(args) },
  "../lib/androidBack": { createAndroidBackHandler: () => {} },
}, { before: [() => source => ts.factory.updateSourceFile(source, source.statements.map(node => {
  if (!ts.isFunctionDeclaration(node) || node.name?.text !== "GlossarySheet") return node;
  return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
    node.typeParameters, node.parameters, node.type,
    ts.factory.updateBlock(node.body, node.body.statements.map(statement =>
      ts.isReturnStatement(statement)
        ? ts.factory.createReturnStatement(ts.factory.createObjectLiteralExpression(
          ["save", "regenerate", "terms", "change", "ready"].map(name => ts.factory.createShorthandPropertyAssignment(name)),
        )) : statement)));
}))] });
const previousWindow = globalThis.window;
globalThis.window = new EventTarget();
const tick = () => new Promise(resolve => setImmediate(resolve));
async function openSheet() {
  let closed = false;
  const sheet = component.GlossarySheet({ bookId: book.id, onClose: () => { closed = true; } });
  mounts.splice(0).forEach(fn => fn());
  await tick();
  assert.equal(sheet.ready(), true);
  return { ...sheet, closed: () => closed };
}
function closeSheet() { cleanups.splice(0).forEach(fn => fn()); }
const signal = new AbortController().signal;
try {
  await settings.ensureTranslationSettings();
  await settings.ensureTranslationBook(book.id);
  await settings.saveTranslationSettings({ target: "ja" });
  let sheet = await openSheet();
  assert.deepEqual(sheet.terms(), chinese);
  sheet.change(0, "note", "edited");
  await sheet.save();
  assert.equal(sheet.closed(), true);
  assert.equal(storedBook.glossaryTarget, "zh-CN", "打开旧语言术语表后保存不能改语言标记");
  closeSheet();
  const beforeJapanese = requests;
  assert.deepEqual(await engine.bookTerms(book, settings.effectiveTranslationSettings(book.id), signal), japanese);
  assert.equal(requests, beforeJapanese + 1, "新目标不能接受旧语言术语，必须生成");
  assert.equal(storedBook.glossaryTarget, "ja");

  // 打开后设置改变，保存仍使用加载时的语言。
  sheet = await openSheet();
  await settings.saveTranslationSettings({ target: "ko" });
  await sheet.save();
  assert.equal(storedBook.glossaryTarget, "ja");
  closeSheet();

  // 重新生成期间切换设置，条目与发起请求时的目标语言一起更新。
  sheet = await openSheet();
  let finish;
  pending = () => new Promise(resolve => { finish = resolve; });
  const generating = sheet.regenerate();
  await tick();
  assert.equal(typeof finish, "function");
  await settings.saveTranslationSettings({ target: "zh-CN" });
  const korean = [{ source: "Alice", target: "앨리스", note: "" }];
  finish(response({ terms: korean }));
  await generating;
  pending = undefined;
  await sheet.save();
  assert.deepEqual(storedBook.terms, korean);
  assert.equal(storedBook.glossaryTarget, "ko");
  closeSheet();

  // 没有语言标记的旧条目不能冒充当前语言；全新空表可手动创建。
  await settings.saveTranslationBook(book.id, { terms: chinese, glossaryTarget: undefined });
  sheet = await openSheet();
  await sheet.save();
  assert.equal(storedBook.glossaryTarget, undefined);
  closeSheet();
  await settings.saveTranslationBook(book.id, { terms: [], glossaryTarget: undefined });
  sheet = await openSheet();
  sheet.terms().push({ source: "Alice", target: "爱丽丝", note: "" }, { source: "", target: "", note: "" });
  await settings.saveTranslationSettings({ target: "ja" });
  await sheet.save();
  assert.deepEqual(storedBook.terms, chinese, "手动保存仍可去掉未填完的空行");
  assert.equal(storedBook.glossaryTarget, "zh-CN");
  closeSheet();

  // 实际提供商解析 + 引擎 + 配置落库：畸形结果拒绝整批，保留旧数据，下次正常重试。
  const invalid = [null, {}, { terms: {} }, { terms: [null] }, { terms: ["Alice"] },
    { terms: [{ original: "Alice", translation: "アリス" }] },
    { terms: [{ source: 1, target: "アリス" }] },
    { terms: [{ source: "Alice", target: " " }] },
    { terms: [{ source: " ", target: "アリス" }] },
    { terms: [{ source: "Alice", target: "アリス", note: 1 }] },
    { terms: [...japanese, { source: "invalid" }] },
    { terms: [...Array(200).fill(japanese[0]), null] }];
  for (const malformed of invalid) {
    await settings.saveTranslationBook(book.id, { terms: chinese, glossaryTarget: "zh-CN" });
    const before = { writes, requests };
    payload = malformed;
    await assert.rejects(engine.bookTerms(book, settings.effectiveTranslationSettings(book.id), signal), /invalidResponse/);
    assert.equal(requests, before.requests + 4, "首次请求加最多三次自动重试");
    assert.equal(writes, before.writes, "无效 AI 响应不能写入空术语表或新语言标记");
    assert.deepEqual(storedBook.terms, chinese);
    assert.equal(storedBook.glossaryTarget, "zh-CN");
    payload = { terms: japanese };
    assert.deepEqual(await engine.bookTerms(book, settings.effectiveTranslationSettings(book.id), signal), japanese);
    assert.equal(requests, before.requests + 5, "重试耗尽后的下一次调用应重新请求");
  }

  // 格式错误和条目错误均自动重试，最后一次允许成功，只有成功结果落库。
  for (const failuresBeforeSuccess of [1, 3]) {
    await settings.saveTranslationBook(book.id, { terms: chinese, glossaryTarget: "zh-CN" });
    const before = { requests, writes };
    pending = () => requests - before.requests <= failuresBeforeSuccess
      ? (requests - before.requests === 1
        ? new Response(JSON.stringify({ choices: [{ message: { content: "invalid JSON" } }] }))
        : response({ terms: [{ invalid: true }] }))
      : response({ terms: japanese });
    assert.deepEqual(await engine.bookTerms(book, settings.effectiveTranslationSettings(book.id), signal), japanese);
    assert.equal(requests, before.requests + failuresBeforeSuccess + 1);
    assert.equal(writes, before.writes + 1, "自动重试只落库成功的结果");
    pending = undefined;
  }

  const stop = new AbortController();
  const beforeCancel = { requests, writes };
  pending = () => { stop.abort(); return response({ terms: [null] }); };
  await assert.rejects(engine.bookTerms(book, settings.effectiveTranslationSettings(book.id), stop.signal, true), { name: "AbortError" });
  await tick();
  assert.equal(requests, beforeCancel.requests + 1, "取消后不能继续重试");
  assert.equal(writes, beforeCancel.writes);
  pending = undefined;

  const beforeMissingModel = requests;
  await assert.rejects(provider.generateTerms(["sample"], { ...storedGlobal, model: "" }, signal), /modelRequired/);
  assert.equal(requests, beforeMissingModel, "配置错误无需自动重试");
  const before = writes;
  payload = { terms: [{ target: "invalid" }] };
  await assert.rejects(engine.bookTerms(book, settings.effectiveTranslationSettings(book.id), signal, true), /invalidResponse/);
  assert.equal(writes, before, "手动重新生成失败也保留既有术语表");
  assert.deepEqual(storedBook.terms, japanese);
  payload = { terms: [] };
  assert.deepEqual(await engine.bookTerms(book, settings.effectiveTranslationSettings(book.id), signal, true), []);
  const afterEmpty = requests;
  assert.deepEqual(await engine.bookTerms(book, settings.effectiveTranslationSettings(book.id), signal), []);
  assert.equal(requests, afterEmpty, "明确的合法空列表可以复用");
  assert.deepEqual(core.normalizeTerms([{ source: " Alice ", target: " アリス " }, ...japanese], true), japanese);
  assert.deepEqual(failures, []);
} finally {
  closeSheet();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}
console.log("glossary regression passed: draft language, regeneration snapshot, strict AI validation, up to three retries, cancellation, failed generation recovery and valid empty output");
