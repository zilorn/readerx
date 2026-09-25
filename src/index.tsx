/* @refresh reload */
import { render } from "solid-js/web";
import { initReaderState } from "./lib/store";
import { initChapterRules } from "./lib/chapterRules";
import { initTextReplacements } from "./lib/textReplacements";
import { initHanConvert } from "./lib/hanConvert";
import { ensureLocalBooksLoaded } from "./lib/books";
import { initGroups } from "./lib/groups";
import { installGlobalErrorReporting, listenBackendErrors, reportFailure } from "./lib/errorReport";
import { createLogger } from "./lib/logger";
import { initFrontendLogLevel } from "./lib/logs";
import "./index.css";
import App from "./App";

const log = createLogger("startup");

// 先让 Rust 后端把主题/字号/书架进度等轻量偏好载入，避免主题闪色与筛选还原错位，
// 再渲染外壳；本地书库（含每本书完整正文）不在首帧前加载——外壳先渲染，
// 书库由 App 挂载后的 effect 在后台加载，书架页在数据就绪前显示加载占位。
async function start() {
  // 尽早同步前端日志级别：上次开了「详细」时要让启动期的 debug 也能回传后端
  void initFrontendLogLevel();
  // 处理不了的异常（未捕获错误 / 未处理的 Promise 拒绝 / 后端内部异常）都要提示用户
  installGlobalErrorReporting();
  void listenBackendErrors();

  log.info("开始载入本地偏好");
  const startedAt = performance.now();
  try {
    await Promise.all([
      initReaderState(),
      initChapterRules(),
      initTextReplacements(),
      initHanConvert(),
      initGroups(),
    ]);
    log.info("本地偏好载入完成", `ms=${Math.round(performance.now() - startedAt)}`);
  } catch (error) {
    // 偏好载入失败仍要继续渲染（用内置默认值），但必须让用户知道；
    // reportFailure 自己会记日志（error 级），这里不再重复记一条
    reportFailure("本地设置载入失败", error, 4_200, "error");
  }

  log.debug("渲染应用外壳");
  render(() => <App />, document.getElementById("root") as HTMLElement);
  // 外壳挂载后立即在后台拉书库，不阻塞首帧；失败时提示而不是静默空白
  log.debug("外壳已渲染，后台开始载入书库");
  void ensureLocalBooksLoaded().catch((error) => {
    reportFailure("书库载入失败", error, 4_200, "error");
  });
}

void start();
