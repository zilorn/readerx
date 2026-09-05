/* @refresh reload */
import { render } from "solid-js/web";
import { initReaderState } from "./lib/store";
import { initChapterRules } from "./lib/chapterRules";
import { initTextReplacements } from "./lib/textReplacements";
import { ensureLocalBooksLoaded } from "./lib/books";
import { initGroups } from "./lib/groups";
import "./index.css";
import App from "./App";

// 先让 Rust 后端把主题/字号/进度/书库载入完毕，再渲染，避免主题闪色。
async function start() {
  await Promise.all([
    initReaderState(),
    initChapterRules(),
    initTextReplacements(),
    initGroups(),
    ensureLocalBooksLoaded().catch(() => undefined),
  ]);
  render(() => <App />, document.getElementById("root") as HTMLElement);
}

void start();
