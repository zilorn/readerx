/* @refresh reload */
import { render } from "solid-js/web";
import { initReaderState } from "./lib/store";
import { initChapterRules } from "./lib/chapterRules";
import { initTextReplacements } from "./lib/textReplacements";
import { ensureLocalBooksLoaded } from "./lib/books";
import { initGroups } from "./lib/groups";
import "./index.css";
import App from "./App";

// 先让 Rust 后端把主题/字号/书架进度等轻量偏好载入，避免主题闪色与筛选还原错位，
// 再渲染外壳；本地书库（含每本书完整正文）不在首帧前加载——外壳先渲染，
// 书库由 App 挂载后的 effect 在后台加载，书架页在数据就绪前显示加载占位。
async function start() {
  await Promise.all([
    initReaderState(),
    initChapterRules(),
    initTextReplacements(),
    initGroups(),
  ]);
  render(() => <App />, document.getElementById("root") as HTMLElement);
  // 外壳挂载后立即在后台拉书库，不阻塞首帧
  void ensureLocalBooksLoaded().catch(() => undefined);
}

void start();
