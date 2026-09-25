import { createMemo, createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { PageTabs } from "../components/PageTabs";
import { JsCodeEditor } from "../components/JsCodeEditor";
import { SourceInfoForm } from "../components/SourceInfoForm";
import { SourceGroupPicker } from "../components/SourceGroupPicker";
import { SourceTestPanel, defaultArgs, type SourceTestResult } from "../components/SourceTestPanel";
import { ScrollArea } from "../components/ScrollArea";
import { SaveIcon, TrashIcon } from "../components/icons";
import {
  TEMPLATE_JS,
  blankBookSource,
  bookSourceList,
  buildBookSourceExportText,
  clearSourceEditor,
  currentEditorSource,
  newBookSourceId,
  persistBookSource,
  removeBookSource,
  setEditorSourceDraft,
} from "../lib/bookSources";
import { ensureSourceGroupsLoaded, sourceGroupById, sourceGroupName } from "../lib/sourceGroups";
import {
  callRemoteSource,
  clearSourceLogin,
  getRemoteSource,
  isSourceLoginSupported,
  loginSourceWebview,
} from "../lib/backend";
import {
  type BookSource,
  type BookSourceCapabilities,
  storageEntryCount,
} from "../lib/bookSourcesTypes";
import { showToast } from "../lib/toast";
import { createLogger } from "../lib/logger";
import { t, type MessageKey } from "../lib/i18n";

/** 书源编辑页的日志出口：测试调用是本页最需要留痕的用户动作 */
const log = createLogger("source-editor");

/** 编辑页内的三块内容（常驻 Tab；不是路由） */
type EditorTab = "info" | "code" | "test";

/** Tab 常量：只存 key，渲染时再 t() */
const EDITOR_TABS: readonly { key: EditorTab; labelKey: MessageKey }[] = [
  { key: "info", labelKey: "sourceEditor.tab.info" },
  { key: "code", labelKey: "sourceEditor.tab.code" },
  { key: "test", labelKey: "sourceEditor.tab.test" },
];

const CODE_DOC_HINT_KEY: MessageKey = "sourceEditor.code.docHint";
const FOOT_PAD = "pb-[calc(28px+env(safe-area-inset-bottom))]";

/** 书源编辑页（新建与编辑共用；会话来自 bookSources.currentEditorSource） */
export default function SourceEditorPage() {
  const navigate = useNavigate();
  const initial = currentEditorSource();
  const isNew = !initial || !bookSourceList().some((s) => s.id === initial.id);
  const draft = () =>
    initial ??
    blankBookSource({ id: newBookSourceId(), js: TEMPLATE_JS });

  const [tab, setTab] = createSignal<EditorTab>("info");
  /** Tab 文案在渲染时求值：语言一变跟着更新（常量表里只有 key） */
  const editorTabs = createMemo(() =>
    EDITOR_TABS.map((item) => ({ key: item.key, label: t(item.labelKey) })),
  );

  const [name, setName] = createSignal(draft().name);
  const [bookSourceUrl, setBookSourceUrl] = createSignal(draft().bookSourceUrl);
  const [author, setAuthor] = createSignal(draft().author);
  const [version, setVersion] = createSignal(draft().version);
  const [enabled, setEnabled] = createSignal(draft().enabled);
  const [autoAuth, setAutoAuth] = createSignal(draft().autoAuth);
  const [userAgent, setUserAgent] = createSignal(draft().userAgent);
  const [headersText, setHeadersText] = createSignal(
    Object.entries(draft().headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );
  const [js, setJs] = createSignal(draft().js);
  const [caps, setCaps] = createSignal<BookSourceCapabilities>({ ...draft().capabilities });
  const [groupId, setGroupId] = createSignal<string | undefined>(draft().groupId);
  const [groupPickerOpen, setGroupPickerOpen] = createSignal(false);

  const [fnName, setFnName] = createSignal<string>("searchBook");
  const [argsText, setArgsText] = createSignal(defaultArgs("searchBook"));
  const [result, setResult] = createSignal<SourceTestResult | null>(null);
  const [testing, setTesting] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [confirmTemplate, setConfirmTemplate] = createSignal(false);

  // 网页登录（应用内 WebView：Android 浮层 / 桌面登录窗口）
  const [loginUrl, setLoginUrl] = createSignal(draft().bookSourceUrl);
  const [loginBusy, setLoginBusy] = createSignal(false);
  const [loginSupported, setLoginSupported] = createSignal(true);

  onMount(() => {
    if (!initial) setEditorSourceDraft(draft());
    void isSourceLoginSupported().then(setLoginSupported);
    void ensureSourceGroupsLoaded();
  });

  function goBack() {
    clearSourceEditor();
    if (window.history.length > 1) navigate(-1);
    else navigate("/sources");
  }

  function buildSource(): BookSource {
    const headers: Record<string, string> = {};
    for (const line of headersText().split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) headers[key] = value;
    }
    const id = draft().id;
    const next: BookSource = {
      schemaVersion: 1,
      id,
      name: name().trim() || t("sourceEditor.unnamedSource"),
      bookSourceUrl: bookSourceUrl().trim(),
      author: author().trim(),
      version: version().trim(),
      comment: draft().comment,
      enabled: enabled(),
      capabilities: caps(),
      userAgent: userAgent().trim(),
      headers,
      autoAuth: autoAuth(),
      updateTime: draft().updateTime || Date.now(),
      js: js(),
    };
    // 分组可能在编辑期间被删掉，落盘前确认它还在
    const gid = groupId();
    if (gid && sourceGroupById(gid)) next.groupId = gid;
    return next;
  }

  function validate(source: BookSource): string | null {
    if (!source.name) return t("sourceEditor.validation.nameRequired");
    if (!source.bookSourceUrl) return t("sourceEditor.validation.urlRequired");
    if (!source.js.trim()) return t("sourceEditor.validation.jsRequired");
    return null;
  }

  async function saveAndStay(): Promise<BookSource> {
    const source = buildSource();
    const err = validate(source);
    if (err) {
      showToast(err, true);
      return source;
    }
    try {
      await persistBookSource(source);
      setEditorSourceDraft(source);
      return source;
    } catch (e) {
      showToast(String(e), true);
      return source;
    }
  }

  async function onSave(back = true) {
    const source = await saveAndStay();
    if (validate(source) === null) {
      showToast(t("sourceEditor.saved"));
      if (back) goBack();
    }
  }

  async function onTest() {
    const source = await saveAndStay();
    if (validate(source) !== null) return;
    setTesting(true);
    setResult(null);
    let parsed: unknown[];
    try {
      parsed = JSON.parse(argsText() || "[]") as unknown[];
      if (!Array.isArray(parsed)) parsed = [parsed];
    } catch {
      setResult({ text: t("sourceEditor.test.argsInvalid"), error: true });
      setTesting(false);
      return;
    }
    const fn = fnName();
    const started = performance.now();
    log.info("书源测试开始", `source=${source.id}`, `sourceName=${source.name}`, `fn=${fn}`);
    const r = await callRemoteSource(source.id, fn, parsed);
    const ms = Math.round(performance.now() - started);
    if (r.ok) {
      // 成功只留一条 debug：返回的书目内容不进日志
      log.debug("书源测试成功", `source=${source.id}`, `fn=${fn}`, `ok=true`, `ms=${ms}`);
    } else {
      log.warn(
        "书源测试失败",
        `source=${source.id}`,
        `sourceName=${source.name}`,
        `fn=${fn}`,
        `ms=${ms}`,
        r.error ?? "无返回",
      );
    }
    const pretty =
      r.ok && r.value !== undefined
        ? JSON.stringify(r.value, null, 2)
        : r.error ?? t("sourceEditor.test.noResult");
    const logText = r.logs.length ? `\n--- console ---\n${r.logs.join("\n")}` : "";
    setResult({
      text: `${
        r.ok ? t("sourceEditor.test.ok", { ms: r.elapsedMs }) : t("common.failed")
      }${t("common.failureSeparator")}\n${pretty.slice(0, 6000)}${logText}`,
      error: !r.ok,
    });
    setTesting(false);
  }

  async function onDelete() {
    if (!confirmDelete()) {
      setConfirmDelete(true);
      window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    try {
      await removeBookSource(draft().id);
      showToast(t("sourceEditor.deleted"));
      goBack();
    } catch (e) {
      showToast(String(e), true);
    }
  }

  async function onCopyJson() {
    const source = await getRemoteSource(draft().id);
    if (!source) return;
    // 与列表页「复制导出 JSON」同一条导出路径：不带本机分组 id，只带分组名
    await navigator.clipboard
      .writeText(buildBookSourceExportText([source]))
      .catch(() => undefined);
    showToast(t("common.copied"));
  }

  /** 填入模板：已有代码时需再点一次确认（避免一键抹掉正在写的内容） */
  function onFillTemplate() {
    if (js().trim() && !confirmTemplate()) {
      setConfirmTemplate(true);
      window.setTimeout(() => setConfirmTemplate(false), 3000);
      return;
    }
    setConfirmTemplate(false);
    setJs(TEMPLATE_JS);
  }

  async function onWebLogin() {
    if (loginBusy()) return;
    const url = (loginUrl().trim() || bookSourceUrl().trim() || draft().bookSourceUrl).trim();
    if (!/^https?:\/\/.+/.test(url)) {
      showToast(t("sourceEditor.validation.loginUrl"), true);
      return;
    }
    setLoginBusy(true);
    const r = await loginSourceWebview(draft().id, url);
    setLoginBusy(false);
    if (r.ok) {
      // 登录成功但后端带了提示（如登录态持久化失败）时按警告展示
      if (r.message) {
        showToast(r.message, true);
      } else {
        const stored = storageEntryCount(r.storage);
        const parts: string[] = [];
        if (r.count > 0) parts.push(t("sourceEditor.login.cookieCount", { count: r.count }));
        if (stored > 0) parts.push(t("sourceEditor.login.storageCount", { count: stored }));
        showToast(
          parts.length > 0
            ? t("sourceEditor.login.captured", { parts: parts.join(t("sourceEditor.login.join")) })
            : t("sourceEditor.login.nothingCaptured"),
        );
      }
    } else if (r.message.includes("取消") || r.message.includes("超时") || r.message.includes("关闭")) {
      showToast(r.message || t("sourceEditor.login.cancelled"));
    } else {
      showToast(r.message || t("sourceEditor.login.failed"), true);
    }
  }

  async function onClearLogin() {
    const removed = await clearSourceLogin(draft().id);
    showToast(removed > 0 ? t("sourceEditor.login.cleared") : t("sourceEditor.login.none"));
  }

  return (
    <div class="page flex h-full min-h-0 flex-col">
      <PageHeader
        title={isNew ? t("sourceEditor.title.new") : t("sourceEditor.title.edit")}
        onBack={goBack}
        right={
          <button
            class="grid h-10 w-10 place-items-center rounded-xl text-text-2 active:scale-[0.94] active:bg-surface-2"
            aria-label={t("sourceEditor.action.save")}
            onClick={() => void onSave(true)}
          >
            <SaveIcon size={20} />
          </button>
        }
      />

      <PageTabs
        tabs={editorTabs()}
        value={tab()}
        onChange={setTab}
        label={t("sourceEditor.tabs.label")}
      />

      {/* 书源信息 */}
      <Show when={tab() === "info"}>
        <ScrollArea
          class="min-h-0 flex-1"
          contentClass={`space-y-5 px-[18px] pt-3 ${FOOT_PAD}`}
        >
          <SourceInfoForm
            name={name()}
            onName={setName}
            bookSourceUrl={bookSourceUrl()}
            onBookSourceUrl={setBookSourceUrl}
            author={author()}
            onAuthor={setAuthor}
            version={version()}
            onVersion={setVersion}
            groupName={sourceGroupName(groupId())}
            onPickGroup={() => setGroupPickerOpen(true)}
            enabled={enabled()}
            onEnabled={setEnabled}
            caps={caps()}
            onCaps={setCaps}
            userAgent={userAgent()}
            onUserAgent={setUserAgent}
            headersText={headersText()}
            onHeadersText={setHeadersText}
            autoAuth={autoAuth()}
            onAutoAuth={setAutoAuth}
            loginUrl={loginUrl()}
            onLoginUrl={setLoginUrl}
            loginBusy={loginBusy()}
            loginSupported={loginSupported()}
            onWebLogin={() => void onWebLogin()}
            onClearLogin={() => void onClearLogin()}
          />

          <Show when={!isNew}>
            <button
              class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-danger-weak px-4 py-2.5 text-[13px] font-semibold text-danger active:scale-[0.98]"
              onClick={() => void onDelete()}
            >
              <TrashIcon size={15} />
              {confirmDelete() ? t("sourceEditor.deleteConfirm") : t("sourceEditor.action.deleteSource")}
            </button>
          </Show>
        </ScrollArea>
      </Show>

      {/* JS 代码：编辑器占满整页剩余空间 */}
      <Show when={tab() === "code"}>
        <div class="flex min-h-0 flex-1 flex-col">
          <div class="flex flex-none items-center justify-between gap-2 px-[18px] pb-1.5 pt-2.5">
            <span class="truncate text-[11px] text-text-3">{t(CODE_DOC_HINT_KEY)}</span>
            <button
              class="flex-none rounded-lg bg-surface-2 px-2 py-1 text-[11px] text-text-2 active:scale-[0.96]"
              onClick={onFillTemplate}
            >
              {confirmTemplate()
                ? t("sourceEditor.code.confirmOverwrite")
                : t("sourceEditor.code.fillTemplate")}
            </button>
          </div>
          <JsCodeEditor
            class="min-h-0 flex-1 border-t border-border"
            value={js()}
            onInput={setJs}
            label={t("sourceEditor.code.ariaLabel")}
          />
        </div>
      </Show>

      {/* 测试 */}
      <Show when={tab() === "test"}>
        <ScrollArea class="min-h-0 flex-1" contentClass={`px-[18px] pt-3 ${FOOT_PAD}`}>
          <SourceTestPanel
            caps={caps()}
            fnName={fnName()}
            onFnName={(fn) => {
              setFnName(fn);
              setResult(null);
            }}
            argsText={argsText()}
            onArgsText={setArgsText}
            testing={testing()}
            result={result()}
            onRun={() => void onTest()}
            onExportJson={() => void onCopyJson()}
          />
        </ScrollArea>
      </Show>
      {/* 归入分组（选择即写入草稿，随保存落盘） */}
      <Show when={groupPickerOpen()}>
        <SourceGroupPicker
          value={groupId()}
          onSelect={(next) => setGroupId(next ?? undefined)}
          onClose={() => setGroupPickerOpen(false)}
        />
      </Show>
    </div>
  );
}
