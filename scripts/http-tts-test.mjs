import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const prefs = { method: "POST", url: "https://tts.invalid/?text={$TEXT}", body: '{"text":"{$TEXT?URLencoding=0}"}', rate: 1.5 };
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url, ...init });
  return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/wav" } });
};
const deps = {
  "@tauri-apps/api/core": { isTauri: () => false }, "@tauri-apps/plugin-http": {},
  "./ttsSettings": {
    currentTtsRate: () => prefs.rate, httpTtsMethod: () => prefs.method,
    httpTtsUrl: () => prefs.url, httpTtsBody: () => prefs.body,
  },
  "./audioCache": {}, "./errorReport": { describeError: String }, "./i18n": { t: key => key },
  "./logger": { createLogger: () => ({ debug() {} }) },
};
const { outputText } = ts.transpileModule(await readFile(new URL("../src/lib/httpTts.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const exports = {};
new Function("require", "exports", outputText)(name => {
  assert.ok(name in deps, name);
  return deps[name];
}, exports);

for (const text of ['He said "Hello".', "C:\\book\\chapter", "第一行\n第二行\r\n\t\u0000", "正文 {$RATE} {$TEXT}", "中文与 emoji 📖"]) {
  await exports.synthesizeHttpAudio(text);
  const request = requests.at(-1);
  assert.deepEqual(JSON.parse(request.body), { text });
  assert.equal(new URL(request.url).searchParams.get("text"), text);
  assert.match(request.headers["Content-Type"], /^application\/json/);
}
prefs.body = '{"text":"prefix \\"{$TEXT?URLencoding=0}\\" suffix","speed":{$RATE},"rate":"{$RATE}","encoded":"{$TEXT}","twice":"{$TEXT?URLencoding=2}"}';
await exports.synthesizeHttpAudio('a"b');
assert.deepEqual(JSON.parse(requests.at(-1).body), {
  text: 'prefix "a"b" suffix', speed: 1.5, rate: "1.5", encoded: encodeURIComponent('a"b'), twice: encodeURIComponent(encodeURIComponent('a"b')),
});
prefs.body = '[{$TEXT?URLencoding=0}, {$RATE}, "{$TEXT?URLencoding=0}"]';
await exports.synthesizeHttpAudio('text "quoted"');
assert.deepEqual(JSON.parse(requests.at(-1).body), ['text "quoted"', 1.5, 'text "quoted"']);

prefs.body = "text={$TEXT}&speed={$RATE}&twice={$TEXT?URLencoding=2}";
await exports.synthesizeHttpAudio('a&b "quoted"');
const form = new URLSearchParams(requests.at(-1).body);
assert.equal(form.get("text"), 'a&b "quoted"');
assert.equal(form.get("speed"), "1.5");
assert.equal(form.get("twice"), encodeURIComponent('a&b "quoted"'));
assert.match(requests.at(-1).headers["Content-Type"], /^application\/x-www-form-urlencoded/);
prefs.method = "GET";
prefs.body = '{"unused":"invalid\\escape"}';
await exports.synthesizeHttpAudio("GET text");
assert.equal(requests.at(-1).body, undefined, "GET 不解析未使用的 JSON body");
prefs.method = "POST";
prefs.body = '{"secret":"private-api-key", "text":"invalid\\escape"}';
const sent = requests.length;
await assert.rejects(exports.synthesizeHttpAudio("private paragraph"), error => {
  assert.equal(error.message, "tts.error.invalidJsonBody");
  return true;
});
assert.equal(requests.length, sent, "非法 JSON 不发请求且不暴露模板或正文");
console.log("HTTP TTS: JSON 转义、控制字符、倍速数值、占位原文、URL/表单及 GET 兼容通过");
