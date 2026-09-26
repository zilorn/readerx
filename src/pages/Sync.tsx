import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { ToggleSwitch } from "../components/ToggleSwitch";
import {
  CheckIcon,
  ChevronRightIcon,
  ClipboardIcon,
  ConflictIcon,
  DeviceIcon,
  RefreshIcon,
  SyncIcon,
  TrashIcon,
} from "../components/icons";
import { t } from "../lib/i18n";
import { createLogger } from "../lib/logger";
import { showToast } from "../lib/toast";
import {
  SYNC_INTERVAL_PRESETS,
  discoverSyncPeers,
  formatSyncInterval,
  joinSyncGroup,
  listSyncPeers,
  refreshSyncStatus,
  resetSyncData,
  setSyncAuto,
  setSyncDeviceName,
  setSyncEnabled,
  syncAppliedTick,
  syncNow,
  syncPairingCode,
  syncStatus,
  syncWithAddr,
  type DiscoveredPeer,
  type SyncPeer,
} from "../lib/sync";

const log = createLogger("sync-page");

/** 时间戳 → 相对时间（同步页只需要「多久以前」这种粒度） */
function relativeTime(ms: number): string {
  if (!ms) return t("sync.time.never");
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return t("sync.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("sync.time.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("sync.time.hoursAgo", { count: hours });
  return t("sync.time.daysAgo", { count: Math.round(hours / 24) });
}

function Section(props: { title: string; children: import("solid-js").JSX.Element }) {
  return (
    <section class="mb-6">
      <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
        {props.title}
      </h2>
      <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
        {props.children}
      </div>
    </section>
  );
}

export default function SyncPage() {
  const navigate = useNavigate();
  const status = syncStatus;
  const [peers, setPeers] = createSignal<SyncPeer[]>([]);
  const [found, setFound] = createSignal<DiscoveredPeer[] | null>(null);
  const [discovering, setDiscovering] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [pairingCode, setPairingCode] = createSignal("");
  const [joinCode, setJoinCode] = createSignal("");
  const [deviceName, setDeviceName] = createSignal("");
  const [resetConfirming, setResetConfirming] = createSignal(false);
  let resetTimer: number | undefined;

  async function reload(): Promise<void> {
    setPeers(await listSyncPeers());
    // 未开启时后端没有引擎，也就不存在配对码（拉了只会报错）
    if (!syncStatus().enabled) {
      setPairingCode("");
      return;
    }
    const code = await syncPairingCode();
    setPairingCode(code ?? "");
  }

  /** 次级页返回：优先回上一页，直接打开链接时回它的入口（设置页） */
  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/settings");
  }

  onMount(() => {
    void refreshSyncStatus().then(() => {
      setDeviceName(syncStatus().deviceName);
      return reload();
    });
  });

  // 设备名 / 开关变化后，本机信息与设备列表跟着刷新。
  // 设备名用函数式写回、且不在 effect 里读 deviceName()：否则用户清空输入框时会被
  // 立刻填回旧名字，等于改不了名。
  createEffect(() => {
    const name = status().deviceName;
    if (name) setDeviceName((current) => current || name);
    if (status().enabled) void reload();
  });

  // 同步改了本地数据（进度 / 书签…）时，设备列表里的「上次同步」也该更新
  createEffect(() => {
    if (syncAppliedTick() > 0) void reload();
  });

  async function onToggle(enabled: boolean): Promise<void> {
    setBusy(true);
    await setSyncEnabled(enabled);
    setBusy(false);
    if (enabled) await reload();
    else setFound(null);
  }

  async function onSaveDeviceName(): Promise<void> {
    const name = deviceName().trim();
    if (!name || name === status().deviceName) return;
    setBusy(true);
    await setSyncDeviceName(name);
    setBusy(false);
    await reload();
  }

  async function onCopyCode(): Promise<void> {
    const code = pairingCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast(t("sync.pairing.copied"));
    } catch (error) {
      // 剪贴板不可用（权限 / 非安全上下文）：让用户手动选中，不静默失败
      log.warn("复制配对码失败", error);
      showToast(t("sync.pairing.copyFailed"), true);
    }
  }

  async function onJoin(): Promise<void> {
    const code = joinCode().trim();
    if (!code) return;
    setBusy(true);
    const ok = await joinSyncGroup(code);
    setBusy(false);
    if (ok) {
      setJoinCode("");
      showToast(t("sync.join.done"));
      await reload();
    }
  }

  async function onDiscover(): Promise<void> {
    setDiscovering(true);
    const list = await discoverSyncPeers();
    setDiscovering(false);
    setFound(list);
    if (list.length === 0) showToast(t("sync.discover.empty"));
  }

  async function onSyncNow(): Promise<void> {
    setBusy(true);
    const outcome = await syncNow();
    setBusy(false);
    await reload();
    if (!outcome) return;
    if (outcome.synced.length > 0) {
      showToast(t("sync.result.ok", { names: outcome.synced.join("、"), count: outcome.synced.length }));
    } else if (outcome.failed.length > 0) {
      showToast(outcome.failed[0], true);
    }
  }

  async function onSyncAddr(addr: string): Promise<void> {
    setBusy(true);
    const outcome = await syncWithAddr(addr);
    setBusy(false);
    await reload();
    if (outcome && outcome.synced.length > 0) showToast(t("sync.result.ok", { names: addr, count: 1 }));
  }

  function onReset(): void {
    if (!resetConfirming()) {
      setResetConfirming(true);
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => setResetConfirming(false), 3000);
      return;
    }
    window.clearTimeout(resetTimer);
    setResetConfirming(false);
    void (async () => {
      setBusy(true);
      const ok = await resetSyncData();
      setBusy(false);
      setPeers([]);
      setFound(null);
      setPairingCode("");
      if (ok) showToast(t("sync.reset.done"));
    })();
  }

  /** 除本机外的已知设备 */
  const remotePeers = () => peers().filter((peer) => !peer.isSelf);

  return (
    <div class="page">
      <PageHeader title={t("sync.title")} onBack={goBack} />
      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        {/* 总开关 */}
        <Section title={t("sync.section.enable")}>
          <div class="flex w-full items-center gap-3 px-4 py-[13px] text-left">
            <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-surface-2 text-text-2">
              <SyncIcon size={18} />
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-[14.5px] font-medium">{t("sync.enable.title")}</span>
              <span class="text-[11.5px] text-text-3">
                {status().enabled ? t("sync.enable.onDesc") : t("sync.enable.offDesc")}
              </span>
            </span>
            <ToggleSwitch
              on={status().enabled}
              label={t("sync.enable.toggle")}
              onChange={() => void onToggle(!status().enabled)}
            />
          </div>
        </Section>

        {/* 未开启时只说明同步什么、不同步什么，不再堆别的入口 */}
        <Show when={status().enabled}>
          {/* 状态 */}
          <Section title={t("sync.section.status")}>
            <div class="flex items-center gap-3 px-4 py-[13px]">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">
                  {status().syncing ? t("sync.status.syncing") : t("sync.status.idle")}
                </span>
                <span class="text-[11.5px] text-text-3">
                  {t("sync.status.lastSync", { time: relativeTime(status().lastSyncMs) })}
                </span>
                <Show when={status().lastError}>
                  {(error) => (
                    <span class="break-all text-[11.5px] text-danger">{error()}</span>
                  )}
                </Show>
              </span>
              <button
                class="inline-flex h-[34px] flex-none items-center gap-1.5 rounded-[9px] bg-accent px-3 text-[13px] font-semibold text-on-accent transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-50"
                disabled={busy() || status().syncing}
                onClick={() => void onSyncNow()}
              >
                <RefreshIcon size={15} />
                {t("sync.action.syncNow")}
              </button>
            </div>

            {/* 冲突入口：有冲突时给出计数，点进去裁决 */}
            <button
              class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-colors duration-150 active:bg-surface-2"
              onClick={() => navigate("/sync-conflicts")}
            >
              <span
                class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px]"
                classList={{
                  "bg-surface-2 text-text-2": status().pendingConflicts === 0,
                  "bg-danger-weak text-danger": status().pendingConflicts > 0,
                }}
              >
                <ConflictIcon size={18} />
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("sync.conflict.title")}</span>
                <span class="text-[11.5px] text-text-3">
                  {status().pendingConflicts > 0
                    ? t("sync.conflict.pending", { count: status().pendingConflicts })
                    : t("sync.conflict.none")}
                </span>
              </span>
              <Show when={status().pendingConflicts > 0}>
                <span class="min-w-[20px] flex-none rounded-full bg-danger px-1.5 text-center text-[11.5px] font-semibold leading-[20px] text-white">
                  {status().pendingConflicts}
                </span>
              </Show>
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </button>
          </Section>

          {/* 本机 */}
          <Section title={t("sync.section.thisDevice")}>
            <div class="flex items-center gap-3 px-4 py-[13px]">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("sync.deviceName.title")}</span>
                <span class="text-[11.5px] text-text-3">{t("sync.deviceName.desc")}</span>
              </span>
            </div>
            <div class="flex items-center gap-2 px-4 py-[13px]">
              <input
                value={deviceName()}
                onInput={(e) => setDeviceName(e.currentTarget.value)}
                class="min-w-0 flex-1 rounded-[10px] border border-border bg-bg px-3 py-[8px] text-[13.5px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onSaveDeviceName();
                }}
              />
              <button
                class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] text-accent transition-colors active:bg-surface-2 disabled:opacity-40"
                aria-label={t("sync.deviceName.save")}
                disabled={busy() || deviceName().trim() === status().deviceName}
                onClick={() => void onSaveDeviceName()}
              >
                <CheckIcon size={17} />
              </button>
            </div>
            <Show when={status().listenAddr}>
              {(addr) => (
                <div class="flex items-center gap-3 px-4 py-[13px]">
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="text-[14.5px] font-medium">{t("sync.address.title")}</span>
                    <span class="text-[11.5px] text-text-3">{t("sync.address.desc")}</span>
                  </span>
                  <span class="flex-none text-[13px] tabular-nums text-text-2">{addr()}</span>
                </div>
              )}
            </Show>
            <div class="flex items-center gap-3 px-4 py-[13px]">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("sync.pairing.title")}</span>
                <span class="text-[11.5px] text-text-3">{t("sync.pairing.desc")}</span>
              </span>
              <button
                class="inline-flex h-[34px] flex-none items-center gap-1.5 rounded-[9px] border border-border px-3 text-[12.5px] font-medium text-text-2 transition-colors active:bg-surface-2"
                onClick={() => void onCopyCode()}
              >
                <ClipboardIcon size={15} />
                {t("sync.pairing.copy")}
              </button>
            </div>
            <div class="px-4 py-[13px]">
              <p class="break-all rounded-[10px] bg-surface-2 px-3 py-2 font-mono text-[12px] leading-[1.5] text-text-2 select-all">
                {pairingCode() || "—"}
              </p>
            </div>
          </Section>

          {/* 连接设备 */}
          <Section title={t("sync.section.connect")}>
            <div class="px-4 py-[13px]">
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("sync.join.title")}</span>
                <span class="text-[11.5px] text-text-3">{t("sync.join.desc")}</span>
              </span>
              <div class="mt-2 flex items-center gap-2">
                <input
                  value={joinCode()}
                  onInput={(e) => setJoinCode(e.currentTarget.value)}
                  placeholder={t("sync.join.placeholder")}
                  class="min-w-0 flex-1 rounded-[10px] border border-border bg-bg px-3 py-[8px] text-[13px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void onJoin();
                  }}
                />
                <button
                  class="inline-flex h-[34px] flex-none items-center justify-center rounded-[9px] bg-accent px-3 text-[13px] font-semibold text-on-accent transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-50"
                  disabled={busy() || !joinCode().trim()}
                  onClick={() => void onJoin()}
                >
                  {t("sync.join.action")}
                </button>
              </div>
            </div>

            <div class="flex w-full items-center gap-3 px-4 py-[13px]">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("sync.discover.title")}</span>
                <span class="text-[11.5px] text-text-3">{t("sync.discover.desc")}</span>
              </span>
              <button
                class="inline-flex h-[34px] flex-none items-center gap-1.5 rounded-[9px] border border-border px-3 text-[12.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                disabled={discovering()}
                onClick={() => void onDiscover()}
              >
                <RefreshIcon size={15} />
                {discovering() ? t("sync.discover.running") : t("sync.discover.action")}
              </button>
            </div>

            <Show when={found()}>
              {(list) => (
                <Show
                  when={list().length > 0}
                  fallback={
                    <div class="px-4 py-[13px] text-[12px] text-text-3">
                      {t("sync.discover.emptyHint")}
                    </div>
                  }
                >
                  <For each={list()}>
                    {(peer) => (
                      <div class="flex items-center gap-3 px-4 py-[13px]">
                        <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-surface-2 text-text-2">
                          <DeviceIcon size={18} />
                        </span>
                        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span class="truncate text-[14.5px] font-medium">{peer.name}</span>
                          <span class="text-[11.5px] text-text-3">{peer.addr}</span>
                        </span>
                        <button
                          class="inline-flex h-[32px] flex-none items-center rounded-[9px] bg-accent-weak px-3 text-[12.5px] font-semibold text-accent transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-80 disabled:opacity-50"
                          disabled={busy()}
                          onClick={() => void onSyncAddr(peer.addr)}
                        >
                          {t("sync.action.syncNow")}
                        </button>
                      </div>
                    )}
                  </For>
                </Show>
              )}
            </Show>

            <Show when={remotePeers().length === 0}>
              <div class="px-4 py-[13px] text-[12px] leading-[1.5] text-text-3">
                {t("sync.peer.empty")}
              </div>
            </Show>

            <Show when={remotePeers().length > 0}>
              <For each={remotePeers()}>
                {(peer) => (
                  <div class="flex items-center gap-3 px-4 py-[13px]">
                    <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-surface-2 text-text-2">
                      <DeviceIcon size={18} />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="truncate text-[14.5px] font-medium">{peer.name}</span>
                      <span class="text-[11.5px] text-text-3">
                        {t("sync.peer.lastSync", {
                          time: relativeTime(peer.lastSyncMs),
                          count: peer.syncCount,
                        })}
                      </span>
                    </span>
                    <Show when={peer.addr}>
                      <button
                        class="inline-flex h-[32px] flex-none items-center rounded-[9px] border border-border px-3 text-[12.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                        disabled={busy()}
                        onClick={() => void onSyncAddr(peer.addr as string)}
                      >
                        {t("sync.action.syncNow")}
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </Section>

          {/* 自动同步 */}
          <Section title={t("sync.section.auto")}>
            <div class="flex w-full items-center gap-3 px-4 py-[13px] text-left">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("sync.auto.title")}</span>
                <span class="text-[11.5px] text-text-3">{t("sync.auto.desc")}</span>
              </span>
              <ToggleSwitch
                on={status().autoSync}
                label={t("sync.auto.toggle")}
                onChange={() =>
                  void setSyncAuto(!status().autoSync, status().autoIntervalSecs)
                }
              />
            </div>
            <Show when={status().autoSync}>
              <div class="flex items-center gap-3 px-4 py-[13px]">
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-[14.5px] font-medium">{t("sync.interval.title")}</span>
                  <span class="text-[11.5px] text-text-3">{t("sync.interval.desc")}</span>
                </span>
              </div>
              <div class="flex flex-wrap gap-1.5 px-4 py-[13px]">
                <For each={SYNC_INTERVAL_PRESETS}>
                  {(secs) => (
                    <button
                      class="rounded-full border px-3 py-[6px] text-[12.5px] transition-colors"
                      classList={{
                        "border-accent bg-accent-weak font-semibold text-accent":
                          status().autoIntervalSecs === secs,
                        "border-border text-text-2": status().autoIntervalSecs !== secs,
                      }}
                      onClick={() => void setSyncAuto(true, secs)}
                    >
                      {formatSyncInterval(secs)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Section>

          {/* 数据 */}
          <Section title={t("sync.section.data")}>
            <div class="flex items-center gap-3 px-4 py-[13px]">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("sync.scope.title")}</span>
                <span class="text-[11.5px] text-text-3">{t("sync.scope.desc")}</span>
              </span>
              <span class="flex-none text-[11.5px] tabular-nums text-text-3">
                {t("sync.scope.count", { count: status().entities })}
              </span>
            </div>
            <button
              class="flex w-full items-center gap-3 px-4 py-[13px] text-left text-danger transition-colors duration-150 active:bg-surface-2"
              onClick={onReset}
            >
              <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-danger-weak text-danger">
                <TrashIcon size={18} />
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">
                  {resetConfirming() ? t("sync.reset.confirm") : t("sync.reset.title")}
                </span>
                <span class="text-[11.5px] text-text-3">{t("sync.reset.desc")}</span>
              </span>
            </button>
          </Section>
        </Show>
      </div>
    </div>
  );
}
