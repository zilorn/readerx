import { createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { PageTabs, type PageTab } from "../components/PageTabs";
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
import { type BookSource, type BookSourceCapabilities } from "../lib/bookSourcesTypes";
import { showToast } from "../lib/toast";

/** 编辑页内的三块内容（常驻 Tab；不是路由） */
type EditorTab = "info" | "code" | "test";

const EDITOR_TABS: readonly PageTab<EditorTab>[] = [
  { key: "info", label: "书源信息" },
  { key: "code", label: "JS代码" },
  { key: "test", label: "测试" },
];

const CODE_DOC_HINT = "入口函数与宿主 API 见 docs/book-source-spec.md / docs/book-source-api.md";
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

  // 网页登录（WebView，仅 Android）
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
      name: name().trim() || "未命名书源",
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
    if (!source.name) return "名称不能为空";
    if (!source.bookSourceUrl) return "站点地址不能为空";
    if (!source.js.trim()) return "JS 代码不能为空";
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
      showToast("书源已保存");
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
      setResult({ text: "参数不是合法 JSON 数组", error: true });
      setTesting(false);
      return;
    }
    const fn = fnName();
    const r = await callRemoteSource(source.id, fn, parsed);
    const pretty =
      r.ok && r.value !== undefined
        ? JSON.stringify(r.value, null, 2)
        : r.error ?? "无返回";
    const logText = r.logs.length ? `\n--- console ---\n${r.logs.join("\n")}` : "";
    setResult({
      text: `${r.ok ? `成功 · ${r.elapsedMs}ms` : "失败"}：\n${pretty.slice(0, 6000)}${logText}`,
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
      showToast("书源已删除");
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
    showToast("书源 JSON 已复制");
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
      showToast("请输入合法的 http/https 登录地址", true);
      return;
    }
    setLoginBusy(true);
    const r = await loginSourceWebview(draft().id, url);
    setLoginBusy(false);
    if (r.ok) {
      // 登录成功但后端带了提示（如 Cookie 持久化失败）时按警告展示
      if (r.message) {
        showToast(r.message, true);
      } else {
        showToast(
          r.count > 0
            ? `已捕获 ${r.count} 个 Cookie 并保存到该书源`
            : "登录完成，但没有捕获到 Cookie",
        );
      }
    } else if (r.message.includes("取消") || r.message.includes("超时") || r.message.includes("关闭")) {
      showToast(r.message || "已取消登录");
    } else {
      showToast(r.message || "登录失败", true);
    }
  }

  async function onClearLogin() {
    const removed = await clearSourceLogin(draft().id);
    showToast(removed > 0 ? "已清空登录 Cookie" : "没有保存的登录 Cookie");
  }

  return (
    <div class="page flex h-full min-h-0 flex-col">
      <PageHeader
        title={isNew ? "新建书源" : "编辑书源"}
        onBack={goBack}
        right={
          <button
            class="grid h-10 w-10 place-items-center rounded-xl text-text-2 active:scale-[0.94] active:bg-surface-2"
            aria-label="保存"
            onClick={() => void onSave(true)}
          >
            <SaveIcon size={20} />
          </button>
        }
      />

      <PageTabs tabs={EDITOR_TABS} value={tab()} onChange={setTab} label="书源编辑" />

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
              {confirmDelete() ? "再点一次确认删除" : "删除书源"}
            </button>
          </Show>
        </ScrollArea>
      </Show>

      {/* JS 代码：编辑器占满整页剩余空间 */}
      <Show when={tab() === "code"}>
        <div class="flex min-h-0 flex-1 flex-col">
          <div class="flex flex-none items-center justify-between gap-2 px-[18px] pb-1.5 pt-2.5">
            <span class="truncate text-[11px] text-text-3">{CODE_DOC_HINT}</span>
            <button
              class="flex-none rounded-lg bg-surface-2 px-2 py-1 text-[11px] text-text-2 active:scale-[0.96]"
              onClick={onFillTemplate}
            >
              {confirmTemplate() ? "再点一次覆盖" : "填入模板"}
            </button>
          </div>
          <JsCodeEditor
            class="min-h-0 flex-1 border-t border-border"
            value={js()}
            onInput={setJs}
            label="书源 JS 代码"
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
