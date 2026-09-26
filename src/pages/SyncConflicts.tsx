import { createEffect, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { ConflictIcon } from "../components/icons";
import { t } from "../lib/i18n";
import { showToast } from "../lib/toast";
import {
  conflictFieldLabel,
  conflictKindLabel,
  conflictReasonLabel,
  listSyncConflicts,
  resolveSyncConflict,
  syncStatus,
  type ConflictChoice,
  type SyncConflict,
} from "../lib/sync";

/**
 * 冲突裁决页：**「不静默丢数据」的兑现处**。
 *
 * 每条冲突都保留了双方原值：同步引擎已经按确定的语义合并（并保证各设备收敛），
 * 这里决定被覆盖的那一方要不要改回来。裁决结果会作为一次新的本地写入同步出去，
 * 因此对端队列里的同一条冲突会随之关闭。
 */
export default function SyncConflictsPage() {
  const navigate = useNavigate();
  const [conflicts, setConflicts] = createSignal<SyncConflict[]>([]);
  const [showSettled, setShowSettled] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  async function reload(): Promise<void> {
    setConflicts(await listSyncConflicts(showSettled()));
  }

  /** 次级页返回：优先回上一页，直接打开链接时回同步页 */
  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/sync");
  }

  // 冲突数变化（同步拉来新的、或刚裁决过一条）时刷新列表；首次进入也走这条路
  let lastPending = -1;
  createEffect(() => {
    const pending = syncStatus().pendingConflicts;
    if (pending === lastPending) return;
    lastPending = pending;
    void reload();
  });

  async function resolve(conflict: SyncConflict, choice: ConflictChoice): Promise<void> {
    setBusy(true);
    const ok = await resolveSyncConflict(conflict.id, choice);
    setBusy(false);
    if (ok) {
      showToast(t("sync.conflict.resolved"));
      await reload();
    }
  }

  return (
    <div class="page">
      <PageHeader title={t("sync.conflict.title")} onBack={goBack} />
      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        <div class="mb-4 flex items-center gap-1.5">
          <button
            class="rounded-full border px-3 py-[6px] text-[12.5px] transition-colors"
            classList={{
              "border-accent bg-accent-weak font-semibold text-accent": !showSettled(),
              "border-border text-text-2": showSettled(),
            }}
            onClick={() => {
              setShowSettled(false);
              void reload();
            }}
          >
            {t("sync.conflict.filterPending")}
          </button>
          <button
            class="rounded-full border px-3 py-[6px] text-[12.5px] transition-colors"
            classList={{
              "border-accent bg-accent-weak font-semibold text-accent": showSettled(),
              "border-border text-text-2": !showSettled(),
            }}
            onClick={() => {
              setShowSettled(true);
              void reload();
            }}
          >
            {t("sync.conflict.filterAll")}
          </button>
        </div>

        <Show
          when={conflicts().length > 0}
          fallback={
            <div class="flex flex-col items-center gap-3 rounded-[14px] border border-border bg-surface px-6 py-12 text-center">
              <span class="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-text-3">
                <ConflictIcon size={22} />
              </span>
              <span class="text-[13.5px] font-medium">{t("sync.conflict.empty")}</span>
              <span class="text-[11.5px] text-text-3">{t("sync.conflict.emptyHint")}</span>
            </div>
          }
        >
          <div class="flex flex-col gap-3">
            <For each={conflicts()}>
              {(conflict) => (
                <article class="overflow-hidden rounded-[14px] border border-border bg-surface">
                  <header class="flex items-center gap-2 px-4 pb-1 pt-3.5">
                    <span class="min-w-0 flex-1 truncate text-[14.5px] font-medium">
                      {conflict.title}
                    </span>
                    <span class="flex-none rounded-full bg-surface-2 px-2 py-[3px] text-[11px] text-text-3">
                      {conflictKindLabel(conflict.kind)}
                    </span>
                  </header>
                  <p class="px-4 pb-2 text-[11.5px] text-text-3">
                    {conflictReasonLabel(conflict.reason)}
                    {" · "}
                    {conflictFieldLabel(conflict.field)}
                    <Show when={conflict.peer}>{(peer) => ` · ${peer()}`}</Show>
                  </p>

                  <div class="flex flex-col gap-1.5 px-4 pb-3">
                    <div class="rounded-[10px] bg-surface-2 px-3 py-2">
                      <div class="mb-1 text-[11px] text-text-3">
                        {t("sync.conflict.localSide")}
                      </div>
                      <p class="break-words text-[13px] leading-[1.5]">
                        {conflict.local ?? t("sync.conflict.emptyValue")}
                      </p>
                    </div>
                    <div class="rounded-[10px] bg-surface-2 px-3 py-2">
                      <div class="mb-1 text-[11px] text-text-3">
                        {t("sync.conflict.remoteSide")}
                      </div>
                      <p class="break-words text-[13px] leading-[1.5]">
                        {conflict.remote ?? t("sync.conflict.emptyValue")}
                      </p>
                    </div>
                  </div>

                  <Show when={conflict.note}>
                    {(note) => (
                      <p class="px-4 pb-3 text-[11.5px] leading-[1.5] text-text-3">{note()}</p>
                    )}
                  </Show>

                  <div class="flex gap-2 border-t border-border px-4 py-3">
                    <button
                      class="inline-flex h-[34px] flex-1 items-center justify-center rounded-[9px] bg-accent px-3 text-[13px] font-semibold text-on-accent transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-50"
                      disabled={busy()}
                      onClick={() => void resolve(conflict, "local")}
                    >
                      {t("sync.conflict.keepLocal")}
                    </button>
                    <button
                      class="inline-flex h-[34px] flex-1 items-center justify-center rounded-[9px] border border-border px-3 text-[13px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                      disabled={busy()}
                      onClick={() => void resolve(conflict, "remote")}
                    >
                      {t("sync.conflict.keepRemote")}
                    </button>
                    <button
                      class="inline-flex h-[34px] flex-none items-center justify-center rounded-[9px] px-3 text-[13px] font-medium text-text-3 transition-colors active:bg-surface-2 disabled:opacity-50"
                      disabled={busy()}
                      onClick={() => void resolve(conflict, "dismiss")}
                    >
                      {t("sync.conflict.dismiss")}
                    </button>
                  </div>
                </article>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
