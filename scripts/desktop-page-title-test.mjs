import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createContext, createRoot, createSignal, onCleanup, untrack } from "../node_modules/solid-js/dist/solid.js";

// 使用真实注册实现与 Solid 浏览器运行时，覆盖保活、动态标题、迟到的懒加载及卸载。
const source = await readFile(new URL("../src/shell/pageTitle.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source.replace(/^import .*;\n/gm, "").replaceAll("export ", ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const [path, setPath] = createSignal("/");
const location = { get pathname() { return path(); } };
let keptPath;
let desktopPlatform = true;
let desktopShell = true;
const api = new Function("createContext", "createSignal", "onCleanup", "untrack", "useContext", "useLocation", "isDesktopPlatform", "isDesktopShell", `${code}\nreturn { registerPageTitle, pageTitleForPath, usesWindowPageTitle };`)(
  createContext, createSignal, onCleanup, untrack, () => keptPath, () => location,
  () => desktopPlatform, () => desktopShell,
);
const mount = (content, fixedPath) => createRoot((dispose) => {
  keptPath = fixedPath;
  api.registerPageTitle(content);
  keptPath = undefined;
  return dispose;
});
const [count, setCount] = createSignal(3);
let backs = 0;
const disposeShelf = mount({ get title() { return count() ? "选择书籍" : "书架"; }, get subtitle() { return String(count()); }, onBack: () => backs++ }, "/");
const current = () => api.pageTitleForPath(path());
assert.equal(current().title, "选择书籍");
setCount(0);
assert.equal(current().title, "书架");
assert.equal(current().subtitle, "0");
setPath("/discover");
const disposeDiscover = mount({ title: "发现" }, "/discover");
setCount(9);
assert.equal(current().title, "发现", "隐藏书架的更新不能覆盖发现页");
// WebDAV 页的 lazy 组件在用户已经切走后才完成加载，仍绑定外壳提供的原路径。
const disposeLate = mount({ title: "WebDAV" }, "/webdav-import");
assert.equal(current().title, "发现");
setPath("/webdav-import");
assert.equal(current().title, "WebDAV");
setPath("/");
assert.equal(current().title, "选择书籍");
current().onBack();
assert.equal(backs, 1);
setPath("/detail/book");
const disposeDetail = mount({ title: "书籍详情" });
assert.equal(current().title, "书籍详情", "路由页可从 Router 取得路径");
disposeDetail();
assert.equal(current(), undefined, "卸载后不能残留旧标题或动作");
assert.equal(api.usesWindowPageTitle(), true);
desktopShell = false;
assert.equal(api.usesWindowPageTitle(), false, "窄窗口保留页内标题");
desktopShell = true;
desktopPlatform = false;
assert.equal(api.usesWindowPageTitle(), false, "Android 和普通浏览器不合并标题");
disposeShelf(); disposeDiscover(); disposeLate();
assert.equal(api.pageTitleForPath("/"), undefined);
console.log("桌面标题注册回归通过：动态标题、保活隔离、迟到加载、返回、卸载与平台分支");
