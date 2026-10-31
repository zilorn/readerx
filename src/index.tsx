/* @refresh reload */
import { render } from "solid-js/web";
import { initReaderState } from "./lib/store";
import { initChapterRules } from "./lib/chapterRules";
import { initTextReplacements } from "./lib/textReplacements";
import { initHanConvert } from "./lib/hanConvert";
import { ensureLocalBooksLoaded } from "./lib/books";
import { initGroups } from "./lib/groups";
import { initI18n, t } from "./lib/i18n";
import { installGlobalErrorReporting, listenBackendErrors, reportFailure } from "./lib/errorReport";
import { initSync } from "./lib/sync";
import { initSourcePrompts } from "./lib/sourcePrompt";
import { migrateStartupData } from "./lib/startup";
import { createLogger } from "./lib/logger";
import { initFrontendLogLevel } from "./lib/logs";
import "./index.css";
import App from "./App";

const log = createLogger("startup");

// 先定下界面语言，再执行页面启动后的数据迁移；迁移完成后才载入主题/字号/书架进度等
// 轻量偏好，避免主题闪色与筛选还原错位，最后渲染外壳。
// 本地书库（含每本书完整正文）不在首帧前加载——外壳先渲染，
// 书库由 App 挂载后的 effect 在后台加载，书架页在数据就绪前显示加载占位。
async function start() {
  // 尽早同步前端日志级别：上次开了「详细」时要让启动期的 debug 也能回传后端
  void initFrontendLogLevel();
  // 处理不了的异常（未捕获错误 / 未处理的 Promise 拒绝 / 后端内部异常）都要提示用户
  installGlobalErrorReporting();
  void listenBackendErrors();
  // 同步服务句柄已在 Rust 侧就绪，引擎等迁移完成后再启动；这里只订阅状态与落地事件
  void initSync();
  // 书源输入表单（input.prompt）：尽早订阅，书源引擎那边正阻塞等用户提交
  void initSourcePrompts();

  // 界面语言先定下来，后续启动失败提示才能用当前语言。
  try {
    await initI18n();
  } catch (error) {
    reportFailure(t("shell.startup.settingsFailed"), error, 4_200, "error");
  }

  // 数据迁移放在页面启动后执行：Rust setup 里同步迁移会占住主线程，
  // Android 覆盖安装后的首启可能因此白屏。迁移完成前不读取依赖稳定 ID 的本地数据。
  log.info("开始启动数据迁移");
  const migrationStartedAt = performance.now();
  try {
    await migrateStartupData();
    log.info("启动数据迁移完成", `ms=${Math.round(performance.now() - migrationStartedAt)}`);
  } catch (error) {
    // 迁移失败保留原数据，仍继续渲染；同步服务不会启动，下次启动可重试。
    reportFailure(t("shell.startup.migrationFailed"), error, 4_200, "error");
  }

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
    reportFailure(t("shell.startup.settingsFailed"), error, 4_200, "error");
  }

  log.debug("渲染应用外壳");
  render(() => <App />, document.getElementById("root") as HTMLElement);
  // 外壳挂载后立即在后台拉书库，不阻塞首帧；失败时提示而不是静默空白
  log.debug("外壳已渲染，后台开始载入书库");
  void ensureLocalBooksLoaded().catch((error) => {
    reportFailure(t("shell.startup.libraryFailed"), error, 4_200, "error");
  });
}

void start();
