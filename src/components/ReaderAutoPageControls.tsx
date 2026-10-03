import { Show } from "solid-js";
import { t } from "../lib/i18n";
import {
  AUTO_PAGE_INTERVAL_MAX,
  AUTO_PAGE_INTERVAL_MIN,
  currentAutoPageInterval,
  setAutoPageInterval,
} from "../lib/store";
import { ToggleSwitch } from "./ToggleSwitch";

export interface ReaderAutoPageControlsProps {
  group: "adjustments" | "switches";
  enabled: boolean;
  onChange: () => void;
}

export function ReaderAutoPageControls(props: ReaderAutoPageControlsProps) {
  return (
    <>
      <Show when={props.group === "switches"}>
        <div class="flex items-center gap-3 px-4 py-[13px]">
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="text-[14.5px] font-medium">{t("readerChrome.settings.autoPage")}</span>
            <span class="text-[11.5px] text-text-3">{t("readerChrome.settings.autoPageDesc")}</span>
          </span>
          <ToggleSwitch on={props.enabled} label={t("readerChrome.settings.autoPage")} onChange={props.onChange} />
        </div>
      </Show>
      <Show when={props.group === "adjustments"}>
        <label class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-[13px]">
          <span class="text-[14.5px] font-medium">{t("readerChrome.settings.autoPageInterval")}</span>
          <span class="ml-auto text-[12.5px] tabular-nums text-text-2">
            {t("readerChrome.settings.autoPageSeconds", { seconds: currentAutoPageInterval() })}
          </span>
          <input
            type="range"
            min={AUTO_PAGE_INTERVAL_MIN}
            max={AUTO_PAGE_INTERVAL_MAX}
            step="1"
            value={currentAutoPageInterval()}
            aria-label={t("readerChrome.settings.autoPageInterval")}
            aria-valuetext={t("readerChrome.settings.autoPageSeconds", { seconds: currentAutoPageInterval() })}
            class="w-full accent-accent"
            onChange={(event) => setAutoPageInterval(Number(event.currentTarget.value))}
          />
        </label>
      </Show>
    </>
  );
}
