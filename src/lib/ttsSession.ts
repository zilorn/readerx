/**
 * 全局听书会话。
 *
 * 播放器不再随阅读页卸载而销毁：离开阅读页后继续按书库里的显示副本往后读，
 * 阅读页重新打开同一本时再接上跟读、分页和高亮。其它页面用底部控制条操作。
 * 同一时间只读一本书；在另一本里点「听书」会先停掉当前这本。
 */
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { bookMetaById, ensureLocalBookContent, localBookById } from "./books";
import { isOnlineBook, type LocalBook } from "./booksTypes";
import { withHanBook, hanText } from "./hanDisplay";
import { withDisplayReplacements } from "./textReplacements";
import {
  chapterHasContent,
  ensureReadingWindow,
  onlineChapterFailure,
  onlineRunBusy,
} from "./online";
import { selectionTranslation } from "./translation/engine";
import { translationKey } from "./translation/core";
import {
  effectiveTranslationSettings,
  translationBookState,
} from "./translation/settings";
import { showToast } from "./toast";
import { t } from "./i18n";
import { createLogger } from "./logger";
import { createTtsPlayer, type TtsPlayer } from "./ttsPlayer";

const log = createLogger("tts");

/** 听书使用的显示副本：替换规则与简繁转换，不改书库原文。 */
export function ttsDisplayBook(
  book: LocalBook | undefined,
  bookId: string,
): LocalBook | undefined {
  return withHanBook(withDisplayReplacements(book, bookId));
}

export interface TtsReaderBinding {
  bookId: string;
  chapterIndex: () => number;
  navigateChapter: (index: number) => void;
  readingOffset: () => number | null;
  pageOffsets?: (chapterIndex: number) => Promise<readonly number[]>;
}

interface SessionApi {
  player: TtsPlayer;
  sessionBookId: () => string | null;
  viewBookId: () => string | null;
  followEnabled: () => boolean;
  setFollowEnabled: (enabled: boolean) => void;
  decodeGuideOpen: () => boolean;
  setDecodeGuideOpen: (open: boolean) => void;
  attach: (binding: TtsReaderBinding) => void;
  /** 初始位置恢复完成后由阅读页调用：此后的章节变化才驱动朗读位置 */
  confirmView: () => void;
  detach: (bookId: string) => void;
  claim: (bookId: string) => void;
}

const session = createRoot((): SessionApi => {
  const [sessionBookId, setSessionBookId] = createSignal<string | null>(null);
  const [viewBookId, setViewBookId] = createSignal<string | null>(null);
  const [followWanted, setFollowWanted] = createSignal(true);
  const [decodeGuideOpen, setDecodeGuideOpen] = createSignal(false);
  /** 已接管视图的阅读页（初始位置恢复完成后才置位） */
  let view: TtsReaderBinding | null = null;
  /** 已挂载、但还没完成初始位置恢复的阅读页 */
  let pendingView: TtsReaderBinding | null = null;

  const sameBook = (): boolean => {
    const id = sessionBookId();
    return !!id && view?.bookId === id;
  };

  /**
   * 构造期还不能读播放器自身的焦点（createTtsPlayer 尚未返回），
   * 先回落到 0；播放器建好后改成它自己的焦点章。
   */
  let focusChapterFallback = (): number => 0;

  async function prepareChapter(index: number): Promise<void> {
    const id = sessionBookId();
    if (!id) return;
    await ensureLocalBookContent(id);
    const initial = localBookById(id);
    if (!initial || !isOnlineBook(initial)) return;
    if (!initial.chapters[index] || chapterHasContent(initial.chapters[index])) return;
    log.info("听书补齐章节正文", `book=${id}`, `chapter=${index}`);
    await ensureReadingWindow(id, index);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const chapter = localBookById(id)?.chapters[index];
      if (!chapter || chapterHasContent(chapter)) return;
      if (onlineChapterFailure(id, index)) return;
      if (!onlineRunBusy(id)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    log.warn("听书等待章节正文超时", `book=${id}`, `chapter=${index}`);
  }

  let player!: TtsPlayer;
  player = createTtsPlayer({
    bookId: () => sessionBookId() ?? "",
    chapterIndex: () => {
      if (sameBook() && view) return view.chapterIndex();
      return focusChapterFallback();
    },
    chapterAt: (index) => {
      const id = sessionBookId();
      if (!id) return undefined;
      return ttsDisplayBook(localBookById(id), id)?.chapters[index];
    },
    chapterCount: () => {
      const id = sessionBookId();
      if (!id) return 0;
      return ttsDisplayBook(localBookById(id), id)?.chapters.length ?? 0;
    },
    followEnabled: () => sameBook() && followWanted(),
    navigateChapter: (index) => {
      if (sameBook() && view) view.navigateChapter(index);
    },
    readingOffset: () => {
      if (sameBook() && view) return view.readingOffset();
      const start = player.focus()?.item.start ?? -1;
      return start >= 0 ? start : null;
    },
    pageOffsets: async (index) => {
      if (sameBook() && view?.pageOffsets) return view.pageOffsets(index);
      return [];
    },
    prepareChapter,
    speechText: async (text, chapterIndex, signal) => {
      const id = sessionBookId();
      if (!id) return text;
      const config = effectiveTranslationSettings(id);
      if (!config.enabled || config.readingText !== "translated") return text;
      const source = localBookById(id);
      const chapter = source?.chapters[chapterIndex];
      if (!source || !chapter) throw new Error(t("translation.stale"));
      return selectionTranslation(source, chapter, text, signal);
    },
    notify: (message, isError) => showToast(message, !!isError),
    onDecodeFailure: () => setDecodeGuideOpen(true),
  });
  // 播放器建好后才能读它自己的焦点；构造期读到的是 0，不影响起播位置。
  focusChapterFallback = () => player.focus()?.chapterIndex ?? 0;

  createEffect(() => {
    if (player.status() === "stopped") setFollowWanted(true);
  });

  createEffect(on(
    () => {
      const id = sessionBookId();
      if (!id) return "";
      const config = effectiveTranslationSettings(id);
      return JSON.stringify([
        id,
        config.enabled,
        config.readingText,
        translationKey("", config, translationBookState(id)?.terms ?? []),
      ]);
    },
    () => {
      if (player.status() !== "stopped") player.refreshText();
    },
    { defer: true },
  ));

  // 阅读页不在这本书上时，把预取焦点交给正在读的章，避免只剩标题就跳过正文。
  createEffect(on(
    () => {
      const id = sessionBookId();
      const index = player.focus()?.chapterIndex ?? -1;
      if (!id || index < 0 || viewBookId() === id) return "";
      if (player.status() === "stopped") return "";
      return `${id}:${index}`;
    },
    (key) => {
      if (!key) return;
      const split = key.lastIndexOf(":");
      const id = key.slice(0, split);
      const index = Number(key.slice(split + 1));
      const book = localBookById(id);
      if (!book || !isOnlineBook(book) || !Number.isInteger(index)) return;
      void ensureReadingWindow(id, index);
    },
    { defer: true },
  ));

  let mediaBound = false;
  function bindMediaSession(media: MediaSession): void {
    if (mediaBound) return;
    mediaBound = true;
    const bind = (name: MediaSessionAction, run: () => void): void => {
      try {
        media.setActionHandler(name, run);
      } catch {
        // 当前平台不提供这个媒体键
      }
    };
    bind("play", () => {
      const status = player.status();
      if (status !== "playing" && status !== "loading") player.togglePlay();
    });
    bind("pause", () => {
      const status = player.status();
      if (status === "playing" || status === "loading") player.togglePlay();
    });
    bind("previoustrack", () => player.prev());
    bind("nexttrack", () => player.next());
    bind("stop", () => player.stop());
  }

  createEffect(() => {
    const status = player.status();
    const focus = player.focus();
    const id = sessionBookId();
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
    if (!media) return;
    bindMediaSession(media);
    if (status === "stopped" || !focus) {
      media.playbackState = "none";
      media.metadata = null;
      return;
    }
    if (typeof MediaMetadata === "undefined") return;
    const title = id ? hanText(bookMetaById(id)?.title ?? "") : "";
    media.metadata = new MediaMetadata({
      title: focus.chapterTitle || title,
      artist: title,
    });
    media.playbackState = status === "paused" || status === "error" ? "paused" : "playing";
  });

  return {
    player,
    sessionBookId,
    viewBookId,
    followEnabled: followWanted,
    setFollowEnabled: setFollowWanted,
    decodeGuideOpen,
    setDecodeGuideOpen,
    attach: (binding) => {
      pendingView = binding;
      view = null;
      setViewBookId(binding.bookId);
      if (player.status() === "stopped") setSessionBookId(binding.bookId);
    },
    /**
     * 阅读页初始位置恢复完成、当前章节可信之后再接管视图。
     * 恢复期间 chapterIdx 还是暂态的 0，此时把章节变化交给播放器会把
     * 暂停中的朗读位置重锚到章首；接管前一律回落到播放器自己的焦点。
     */
    confirmView: () => {
      const pending = pendingView;
      if (!pending || viewBookId() !== pending.bookId) return;
      pendingView = null;
      view = pending;
    },
    detach: (bookId) => {
      if (pendingView?.bookId === bookId) pendingView = null;
      if (viewBookId() === bookId) setViewBookId(null);
      if (view?.bookId !== bookId) return;
      const keep = player.status() !== "stopped" && sessionBookId() === bookId;
      view = null;
      if (keep) {
        log.info(
          "离开阅读页，听书继续",
          `book=${bookId}`,
          `chapter=${player.focus()?.chapterIndex ?? -1}`,
        );
      }
    },
    claim: (bookId) => {
      if (!bookId || sessionBookId() === bookId) return;
      if (player.status() !== "stopped") player.stop();
      setSessionBookId(bookId);
    },
  };
});

export function globalTtsPlayer(): TtsPlayer {
  return session.player;
}

export function ttsSessionBookId(): string | null {
  return session.sessionBookId();
}

/** 正在听的书正打开在阅读页里（阅读页自己的控制条接管，全局条让开） */
export function ttsPlayingInOpenReader(): boolean {
  const id = session.sessionBookId();
  return !!id && session.viewBookId() === id && session.player.status() !== "stopped";
}

export function ttsFollowEnabled(): boolean {
  return session.followEnabled();
}

export function setTtsFollowEnabled(enabled: boolean): void {
  session.setFollowEnabled(enabled);
}

export function ttsDecodeGuideOpen(): boolean {
  return session.decodeGuideOpen();
}

export function setTtsDecodeGuideOpen(open: boolean): void {
  session.setDecodeGuideOpen(open);
}

export function attachTtsReader(binding: TtsReaderBinding): void {
  session.attach(binding);
}

/**
 * 阅读页初始位置（章节 + 偏移）恢复落定后调用。
 * 调用前会话不接管视图：挂载瞬间的暂态章节不会重锚暂停中的朗读位置。
 */
export function confirmTtsReaderView(): void {
  session.confirmView();
}

export function detachTtsReader(bookId: string): void {
  session.detach(bookId);
}

/** 开始听另一本书之前调用：先停掉当前会话再把播放器指到这本书。 */
export function claimTtsBook(bookId: string): void {
  session.claim(bookId);
}
