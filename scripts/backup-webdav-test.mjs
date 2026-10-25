import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createSignal } from "solid-js";

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
const server = id => ({ id, name: id, url: `https://${id}.invalid`, username: "", password: "", createdAt: 1 });
const disk = new Map([
  ["readerx.webdavServers", [server("old")]], ["readerx.webdavActive", "old"],
]);
let holdRead;
const webdav = await load("webdav", {
  "solid-js": { createSignal },
  "./backend": {
    async readState(key) {
      const value = structuredClone(disk.get(key) ?? null);
      if (holdRead) await holdRead;
      return value;
    },
    async writeState(key, value) { disk.set(key, structuredClone(value)); },
  },
  "./http": {}, "./books": {}, "./store": {},
  "./logger": { createLogger: () => ({ info() {} }) }, "./i18n": { t: key => key },
});
await webdav.ensureWebDavLoaded();
assert.equal(webdav.davActiveId(), "old");

let incoming = { servers: [server("restored")], active: "restored" };
const noop = async () => {};
const backup = await load("backup", {
  "@tauri-apps/api/core": {
    isTauri: () => true, Channel: class {},
    async invoke(command) {
      assert.equal(command, "readerx_data_import");
      disk.set("readerx.webdavServers", incoming.servers);
      disk.set("readerx.webdavActive", incoming.active);
      return { stateKeys: ["readerx.webdavServers", "readerx.webdavActive"] };
    },
  },
  "./annotations": { flushAnnotationWrites: noop, invalidateAnnotationCache: noop },
  "./bookmarks": { invalidateBookmarkCache: noop }, "./books": { reloadLocalBooks: noop },
  "./bookSources": { refreshBookSources: noop }, "./chapterRules": { reloadChapterRules: noop },
  "./groups": { reloadGroups: noop }, "./readingTime": { loadReadingTime: noop },
  "./store": { reloadReadingProgress: noop }, "./sourceGroups": { reloadSourceGroups: noop },
  "./textReplacements": { reloadTextReplacements: noop }, "./webdav": webdav,
  "./i18n": { t: key => key },
});

await backup.importBackup("fixture.zip", "replace", noop);
await webdav.ensureWebDavLoaded();
assert.equal(webdav.davActiveId(), "restored");
assert.deepEqual(webdav.davServers(), incoming.servers);
webdav.createDavServer({ name: "new", url: "https://new.invalid", username: "", password: "" });
assert.equal(disk.get("readerx.webdavServers").length, 2);
assert.equal(disk.get("readerx.webdavServers")[0].id, "restored", "后续编辑保留恢复配置");

// 导入期间仍在飞的旧读取不能在导入后的重载完成后覆盖新配置。
let release;
holdRead = new Promise(resolve => { release = resolve; });
const stale = webdav.reloadWebDav();
holdRead = undefined;
incoming = { servers: [server("latest")], active: "latest" };
await backup.importBackup("fixture.zip", "merge", noop);
release();
await stale;
assert.equal(webdav.davActiveId(), "latest");
assert.equal(webdav.davServers()[0].id, "latest");

incoming = { servers: [], active: "missing" };
await backup.importBackup("fixture.zip", "replace", noop);
assert.deepEqual(webdav.davServers(), []);
assert.equal(webdav.davActiveId(), null);
incoming = { servers: null, active: null };
await backup.importBackup("fixture.zip", "replace", noop);
assert.deepEqual(webdav.davServers(), []);
assert.equal(webdav.activeDavServer(), undefined);
assert.equal(webdav.davReady(), true);
console.log("backup WebDAV: 导入重载、后续编辑、在飞读取隔离与空配置通过");
