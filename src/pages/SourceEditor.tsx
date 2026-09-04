import { createSignal, For, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { SaveIcon, TestIcon, TrashIcon } from "../components/icons";
import {
  TEMPLATE_JS,
  blankBookSource,
  bookSourceList,
  clearSourceEditor,
  currentEditorSource,
  newBookSourceId,
  persistBookSource,
  removeBookSource,
  setEditorSourceDraft,
} from "../lib/bookSources";
import { callRemoteSource, getRemoteSource } from "../lib/backend";
import {
  CAPABILITY_LABELS,
  ENTRY_FUNCTION_META,
  type BookSource,
  type BookSourceCapabilities,
} from "../lib/bookSourcesTypes";
import { showToast } from "../lib/toast";

function defaultArgs(fnName: string): string {
  switch (fnName) {
    case "searchBook":
      return '["搜索关键词"]';
    case "discoverBooks":
      return '[{ "name": "", "url": "" }]';
    case "discoverCategories":
      return "[]";
    case "bookDetail":
      return '[{ "bookName": "书名", "bookUrl": "https://" }]';
    case "bookToc":
      return '[{ "bookName": "书名", "bookUrl": "https://" }]';
    case "bookContent":
      return '[\n  { "chapterName": "第一章", "chapterUrl": "https://" },\n  { "bookName": "书名", "bookUrl": "https://" }\n]';
  }
  return "[]";
}

/** 书源编辑页（新建与编辑共用；会话来自 bookSources.currentEditorSource） */
export default function SourceEditorPage() {
  const navigate = useNavigate();
  const initial = currentEditorSource();
  const isNew = !initial || !bookSourceList().some((s) => s.id === initial.id);
  const draft = () =>
    initial ??
    blankBookSource({ id: newBookSourceId(), js: TEMPLATE_JS });

  const [name, setName] = createSignal(draft().name);
  const [bookSourceUrl, setBookSourceUrl] = createSignal(draft().bookSourceUrl);
  const [author, setAuthor] = createSignal(draft().author);
  const [version, setVersion] = createSignal(draft().version);
  const [enabled, setEnabled] = createSignal(draft().enabled);
  const [userAgent, setUserAgent] = createSignal(draft().userAgent);
  const [headersText, setHeadersText] = createSignal(
    Object.entries(draft().headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );
  const [js, setJs] = createSignal(draft().js);
  const [caps, setCaps] = createSignal<BookSourceCapabilities>({ ...draft().capabilities });

  const [fnName, setFnName] = createSignal<string>("searchBook");
  const [argsText, setArgsText] = createSignal(defaultArgs("searchBook"));
  const [result, setResult] = createSignal<{ text: string; error: boolean } | null>(null);
  const [testing, setTesting] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  onMount(() => {
    if (!initial) setEditorSourceDraft(draft());
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
    return {
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
      updateTime: draft().updateTime || Date.now(),
      js: js(),
    };
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
    await navigator.clipboard.writeText(JSON.stringify(source, null, 2)).catch(() => undefined);
    showToast("书源 JSON 已复制");
  }

  const capabilityKeys = (): (keyof BookSourceCapabilities)[] => Object.keys(CAPABILITY_LABELS) as (keyof BookSourceCapabilities)[];

  return (
    <div class="page">
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

      <div class="space-y-5 px-[18px] pb-[calc(40px+env(safe-area-inset-bottom))] pt-3">
        {/* 元信息 */}
        <section class="space-y-2.5">
          <label class="flex flex-col gap-1">
            <span class="text-[11.5px] font-semibold text-text-3">名称</span>
            <input
              class="rounded-[10px] border border-border bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-accent"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11.5px] font-semibold text-text-3">站点地址（bookSourceUrl）</span>
            <input
              class="rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
              value={bookSourceUrl()}
              onInput={(e) => setBookSourceUrl(e.currentTarget.value)}
            />
          </label>
          <div class="flex gap-2.5">
            <label class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="text-[11.5px] font-semibold text-text-3">作者</span>
              <input
                class="rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
                value={author()}
                onInput={(e) => setAuthor(e.currentTarget.value)}
              />
            </label>
            <label class="flex w-24 flex-col gap-1">
              <span class="text-[11.5px] font-semibold text-text-3">版本</span>
              <input
                class="rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
                value={version()}
                onInput={(e) => setVersion(e.currentTarget.value)}
              />
            </label>
          </div>
        </section>

        {/* 启用与能力开关 */}
        <section class="rounded-[14px] border border-border bg-surface">
          <button
            class="flex w-full items-center justify-between px-4 py-3"
            onClick={() => setEnabled(!enabled())}
          >
            <span class="text-[14px] font-medium">启用书源</span>
            <span
              class={`relative h-6 w-11 flex-none rounded-full transition-colors duration-150 ${
                enabled() ? "bg-accent" : "bg-surface-2"
              }`}
            >
              <span
                class={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] duration-150 ${
                  enabled() ? "left-[22px]" : "left-0.5"
                }`}
              />
            </span>
          </button>
          <div class="divide-y divide-border border-t border-border">
            <For each={capabilityKeys()}>
              {(key) => (
                <button
                  class="flex w-full items-center justify-between px-4 py-2.5"
                  onClick={() =>
                    setCaps({ ...caps(), [key]: !caps()[key] })
                  }
                >
                  <span class="text-[13.5px] text-text-2">{CAPABILITY_LABELS[key]}</span>
                  <span
                    class={`relative h-6 w-11 flex-none rounded-full transition-colors duration-150 ${
                      caps()[key] ? "bg-accent" : "bg-surface-2"
                    }`}
                  >
                    <span
                      class={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] duration-150 ${
                        caps()[key] ? "left-[22px]" : "left-0.5"
                      }`}
                    />
                  </span>
                </button>
              )}
            </For>
          </div>
        </section>

        {/* 请求与会话 */}
        <section class="space-y-2.5">
          <label class="flex flex-col gap-1">
            <span class="text-[11.5px] font-semibold text-text-3">
              User-Agent（留空用内置默认；过 CF 等站点可在此填浏览器 UA）
            </span>
            <input
              class="rounded-[10px] border border-border bg-surface px-3 py-2 text-[12px] outline-none focus:border-accent"
              value={userAgent()}
              onInput={(e) => setUserAgent(e.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11.5px] font-semibold text-text-3">
              默认请求头（每行「名称: 值」，Cookie 等可在此粘贴，CF 站点见 docs/cloudflare.md）
            </span>
            <textarea
              class="min-h-16 resize-y rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-[11.5px] leading-[1.6] outline-none focus:border-accent"
              rows={3}
              value={headersText()}
              onInput={(e) => setHeadersText(e.currentTarget.value)}
            />
          </label>
        </section>

        {/* JS 代码 */}
        <section class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-[11.5px] font-semibold text-text-3">JS 代码（书源函数）</span>
            <button
              class="rounded-lg bg-surface-2 px-2 py-1 text-[11px] text-text-2 active:scale-[0.96]"
              onClick={() => {
                if (!js().trim()) setJs(TEMPLATE_JS);
              }}
            >
              填入模板
            </button>
          </div>
          <textarea
            class="min-h-72 w-full resize-y rounded-[12px] border border-border bg-surface px-3 py-2.5 font-mono text-[12px] leading-[1.6] outline-none focus:border-accent"
            spellcheck={false}
            value={js()}
            onInput={(e) => setJs(e.currentTarget.value)}
          />
          <p class="text-[11px] leading-[1.6] text-text-3">
            入口函数与宿主 API 见 docs/book-source-spec.md / docs/book-source-api.md
          </p>
        </section>

        {/* 测试面板 */}
        <section class="rounded-[14px] border border-border bg-surface">
          <div class="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <span class="text-[13px] font-bold">测试</span>
            <span class="text-[11px] text-text-3">保存当前代码后运行</span>
          </div>
          <div class="space-y-2.5 px-4 py-3">
            <div class="flex flex-wrap gap-1.5">
              {ENTRY_FUNCTION_META.map((m) => (
                <button
                  class="rounded-lg px-2.5 py-1.5 text-[12px] font-semibold"
                  classList={{
                    "bg-accent text-on-accent": fnName() === m.fnName,
                    "bg-surface-2 text-text-2": fnName() !== m.fnName,
                    "opacity-45": !caps()[m.capability],
                  }}
                  onClick={() => {
                    setFnName(m.fnName);
                    setArgsText(defaultArgs(m.fnName));
                    setResult(null);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <textarea
              class="min-h-12 w-full resize-y rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-[11.5px] leading-[1.5] outline-none focus:border-accent"
              rows={2}
              value={argsText()}
              onInput={(e) => setArgsText(e.currentTarget.value)}
            />
            <div class="flex items-center gap-2.5">
              <button
                class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-on-accent active:scale-[0.98] disabled:opacity-50"
                disabled={testing()}
                onClick={() => void onTest()}
              >
                <TestIcon size={16} />
                {testing() ? "运行中…" : "保存并测试"}
              </button>
              <button
                class="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] font-semibold text-text-2 active:scale-[0.98]"
                onClick={() => void onCopyJson()}
              >
                导出 JSON
              </button>
            </div>
            <Show when={result() !== null}>
              <pre
                class={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[10px] px-3 py-2.5 text-[11px] leading-[1.6] ${
                  result()!.error ? "bg-danger-weak text-danger" : "bg-surface-2 text-text-2"
                }`}
              >
                {result()!.text}
              </pre>
            </Show>
          </div>
        </section>

        {/* 删除 */}
        <Show when={!isNew}>
          <button
            class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-danger-weak px-4 py-2.5 text-[13px] font-semibold text-danger active:scale-[0.98]"
            onClick={() => void onDelete()}
          >
            <TrashIcon size={15} />
            {confirmDelete() ? "再点一次确认删除" : "删除书源"}
          </button>
        </Show>
      </div>
    </div>
  );
}
