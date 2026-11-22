/**
 * 离开阅读页后的听书控制条：回到原书、上一句 / 下一句、暂停和停止。
 * 阅读页自己的悬浮球在场时不显示，避免两套控制叠在一起。
 */
import { Show, createSignal } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { bookMetaById } from "../lib/books";
import { hanText } from "../lib/hanDisplay";
import { t } from "../lib/i18n";
import { isDesktopShell } from "../lib/platform";
import { isTabRoute } from "../shell/routes";
import { showToast } from "../lib/toast";
import {
  globalTtsPlayer,
  ttsPlayingInOpenReader,
  ttsSessionBookId,
} from "../lib/ttsSession";
import { TtsSheet } from "./TtsSheet";
import {
  CloseIcon,
  PauseIcon,
  PlayIcon,
  SettingsIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "./icons";

export function TtsNowPlaying() {
  const navigate = useNavigate();
  const location = useLocation();
  const player = globalTtsPlayer();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [prewarmText, setPrewarmText] = createSignal<string | null>(null);
  const visible = () => player.status() !== "stopped" && !ttsPlayingInOpenReader();
  const aboveTabs = () => !isDesktopShell() && isTabRoute(location.pathname);
  const bookTitle = () => {
    const id = ttsSessionBookId();
    return id ? hanText(bookMetaById(id)?.title ?? "") : "";
  };

  async function prewarm(): Promise<void> {
    if (prewarmText() !== null) return;
    setPrewarmText(t("reader.prewarmPreparing"));
    const done = await player.warmBook((current, total) => {
      setPrewarmText(`${current} / ${total}`);
    });
    setPrewarmText(null);
    if (done > 0) showToast(t("reader.prewarmDone", { count: done }));
  }

  return (
    <Show when={visible()}>
      <>
      <div
        class="absolute inset-x-3 z-40 mx-auto flex max-w-[520px] items-center gap-1 rounded-2xl border border-border bg-surface/95 py-1 pl-3 pr-1 shadow-[0_8px_28px_rgb(0_0_0/0.22)] backdrop-blur-md"
        classList={{
          "bottom-4": isDesktopShell(),
          "bottom-[calc(12px+env(safe-area-inset-bottom))]": !isDesktopShell() && !aboveTabs(),
          "bottom-[calc(58px+max(env(safe-area-inset-bottom),20px))]": !isDesktopShell() && aboveTabs(),
        }}
      >
        <button
          type="button"
          class="min-w-0 flex-1 py-1 text-left"
          aria-label={t("tts.now.open")}
          onClick={() => {
            const id = ttsSessionBookId();
            if (id) navigate(`/book/${id}`);
          }}
        >
          <div class="truncate text-[13px] font-semibold text-text">{bookTitle()}</div>
          <div class="truncate text-[11px] text-text-2">
            {player.focus()?.chapterTitle || ""}
          </div>
        </button>
        <button
          type="button"
          class="grid h-9 w-9 flex-none place-items-center rounded-full text-text-2 active:bg-surface-2"
          aria-label={t("tts.bubble.prev")}
          onClick={() => player.prev()}
        >
          <SkipBackIcon size={18} />
        </button>
        <button
          type="button"
          class="grid h-10 w-10 flex-none place-items-center rounded-full bg-accent text-on-accent"
          aria-label={player.status() === "playing" || player.status() === "loading" ? t("tts.bubble.pause") : t("tts.bubble.play")}
          onClick={() => player.togglePlay()}
        >
          <Show
            when={player.status() === "playing" || player.status() === "loading"}
            fallback={<PlayIcon size={18} class="translate-x-[1px]" />}
          >
            <PauseIcon size={18} />
          </Show>
        </button>
        <button
          type="button"
          class="grid h-9 w-9 flex-none place-items-center rounded-full text-text-2 active:bg-surface-2"
          aria-label={t("tts.bubble.next")}
          onClick={() => player.next()}
        >
          <SkipForwardIcon size={18} />
        </button>
        <button
          type="button"
          class="grid h-9 w-9 flex-none place-items-center rounded-full text-text-2 active:bg-surface-2"
          aria-label={t("tts.sheet.title")}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon size={17} />
        </button>
        <button
          type="button"
          class="grid h-9 w-9 flex-none place-items-center rounded-full text-text-2 active:bg-surface-2"
          aria-label={t("tts.now.stop")}
          onClick={() => player.stop()}
        >
          <CloseIcon size={16} />
        </button>
      </div>
      <TtsSheet
        open={settingsOpen()}
        engine={player.engine}
        rate={player.rate}
        voiceId={player.voice}
        timerMode={player.timerMode}
        timerMinutes={player.timerMinutes}
        timerFinishChapter={player.timerFinishChapter}
        timerRemainSec={player.timerRemainSec}
        onEngine={(engine) => player.setEngine(engine)}
        onRate={(rate) => player.setRate(rate)}
        onVoice={(voiceId) => player.setVoice(voiceId)}
        onTimer={(mode, minutes) => player.setTimer(mode, minutes)}
        onTimerFinishChapter={player.setTimerFinishChapter}
        prewarmText={prewarmText}
        onPrewarmBook={() => void prewarm()}
        onStop={() => player.stop()}
        onClose={() => setSettingsOpen(false)}
      />
      </>
    </Show>
  );
}
