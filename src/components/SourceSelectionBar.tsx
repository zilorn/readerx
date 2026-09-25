import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import { FileTextIcon, FolderIcon, PowerIcon, TrashIcon } from "./icons";
import { t } from "../lib/i18n";

/** 删除确认的有效时长：超时后按钮回到「删除」 */
const CONFIRM_WINDOW_MS = 3000;

interface SourceSelectionBarProps {
  /** 已选书源数量（0 时不显示操作条） */
  count: number;
  /** 批量操作进行中：按钮置灰，避免重复触发 */
  busy: boolean;
  onSetEnabled: (enabled: boolean) => void;
  onAssignGroup: () => void;
  onExport: () => void;
  onDelete: () => void;
}

/** 书源多选的底部操作条：启停 / 归组 / 导出 / 删除（删除需连点两次确认） */
export function SourceSelectionBar(props: SourceSelectionBarProps) {
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  let confirmTimer: number | undefined;

  onCleanup(() => window.clearTimeout(confirmTimer));

  function requestDelete() {
    if (!confirmDelete()) {
      setConfirmDelete(true);
      window.clearTimeout(confirmTimer);
      confirmTimer = window.setTimeout(() => setConfirmDelete(false), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer);
    setConfirmDelete(false);
    props.onDelete();
  }

  return (
    <Show when={props.count > 0}>
      <div class="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[var(--app-column)] animate-sheet-up border-t border-border bg-surface px-[18px] pb-[calc(10px+env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_28px_rgb(0_0_0/0.14)]">
        <div class="flex items-stretch gap-2">
          <BarAction
            label={t("common.enable")}
            disabled={props.busy}
            onClick={() => props.onSetEnabled(true)}
          >
            <PowerIcon size={17} />
          </BarAction>
          <BarAction
            label={t("common.disable")}
            disabled={props.busy}
            onClick={() => props.onSetEnabled(false)}
          >
            <PowerIcon size={17} />
          </BarAction>
          <BarAction
            label={t("sources.batch.group")}
            disabled={props.busy}
            onClick={props.onAssignGroup}
          >
            <FolderIcon size={17} />
          </BarAction>
          <BarAction
            label={t("sources.batch.export")}
            disabled={props.busy}
            onClick={props.onExport}
          >
            <FileTextIcon size={17} />
          </BarAction>
          <BarAction
            label={confirmDelete() ? t("common.confirm") : t("common.delete")}
            danger
            active={confirmDelete()}
            disabled={props.busy}
            onClick={requestDelete}
          >
            <TrashIcon size={17} />
          </BarAction>
        </div>
      </div>
    </Show>
  );
}

function BarAction(props: {
  label: string;
  danger?: boolean;
  /** 强调态（如删除的二次确认） */
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      class="inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-xl border px-1 py-[10px] text-[12.5px] font-medium transition-colors active:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
      classList={{
        "border-transparent bg-danger text-white": props.danger && props.active,
        "border-border bg-bg": !(props.danger && props.active),
        "text-danger": props.danger && !props.active,
        "text-text-2": !props.danger,
      }}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span class="flex-none">{props.children}</span>
      <span class="truncate">{props.label}</span>
    </button>
  );
}
