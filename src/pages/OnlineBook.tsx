import { createMemo, createSignal, Show } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { BookIcon, RefreshIcon, SourceIcon } from "../components/icons";
import { SourceCover } from "../components/SourceCover";
import { hanText } from "../lib/hanDisplay";
import { bookMetaList } from "../lib/books";
import {
  LAZY_WINDOW,
  addOnlineBookToShelf,
  fetchBookToc,
  getPicked,
} from "../lib/online";
import { showToast } from "../lib/toast";

/** 在线书预览：仅展示搜索结果已有信息；点「加入书架」时才获取一次目录 */
export default function OnlineBookPage() {
  const params = useParams();
  const navigate = useNavigate();
  const pick = createMemo(() => getPicked(params.key ?? ""));

  const [adding, setAdding] = createSignal(false);
  const [error, setError] = createSignal("");

  const alreadyOnShelf = createMemo(() => {
    const p = pick();
    if (!p) return null;
    return (
      bookMetaList().find(
        (b) => b.bookSourceId === p.source.id && b.bookUrl === p.item.bookUrl,
      ) ?? null
    );
  });

  /** 封面：已在书架的书直接用已落盘封面；否则用书源搜索返回的 cover（可选） */
  const coverSrc = createMemo(() => {
    const shelf = alreadyOnShelf();
    if (shelf?.cover) return shelf.cover;
    return pick()?.item.cover;
  });

  async function onAddToShelf(openReader: boolean) {
    const p = pick();
    if (!p) return;
    setAdding(true);
    setError("");
    try {
      const existing = alreadyOnShelf();
      let bookId = existing?.id;
      if (!existing) {
        // 只在用户明确“加入书架”时拉一次目录
        const chapters = await fetchBookToc(p.source, p.item);
        const book = await addOnlineBookToShelf(p.source, p.item, chapters);
        bookId = book.id;
        showToast("已加入书架");
      } else {
        showToast("已在书架中");
      }
      if (bookId && openReader) navigate(`/book/${bookId}`);
      else navigate("/");
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showToast(msg, true);
    }
    setAdding(false);
  }

  const item = () => pick()?.item;
  /** 展示用书籍信息（简繁转换副本；书源原始数据与入架落盘内容不变） */
  const meta = () => ({
    name: hanText(item()?.bookName ?? ""),
    author: hanText(item()?.author ?? ""),
    latest: hanText(item()?.latest ?? ""),
    updateTime: item()?.updateTime ?? "",
    intro: hanText(item()?.intro ?? ""),
  });

  return (
    <div class="page">
      <PageHeader
        title="在线书"
        subtitle={pick() ? pick()!.source.name : undefined}
        onBack={() => {
          if (window.history.length > 1) navigate(-1);
          else navigate("/discover");
        }}
      />
      <Show
        when={pick() !== null}
        fallback={
          <div class="flex flex-col items-center gap-2 px-6 py-16 text-center text-text-3">
            <SourceIcon size={44} />
            <p class="text-[14px] font-semibold text-text-2">这本书已失效</p>
            <p class="text-[12px]">请回到「发现」页重新搜索</p>
          </div>
        }
      >
        <div class="px-[18px] pb-[calc(40px+env(safe-area-inset-bottom))] pt-2">
          <div class="flex gap-3.5">
            {/* 书源返回 cover 时展示真实封面（经书源会话下载）；无封面回退首字渐变占位 */}
            <SourceCover
              variant="sheet"
              sourceId={pick()?.source.id ?? ""}
              url={coverSrc()}
              referer={pick()?.item.bookUrl}
              title={meta().name}
            />
            <div class="flex min-w-0 flex-1 flex-col justify-center gap-1">
              <h2 class="text-[17px] font-bold leading-snug">{meta().name}</h2>
              <p class="truncate text-[12.5px] text-text-3">
                {meta().author || "佚名"}
              </p>
              <Show when={meta().latest}>
                <p class="truncate text-[12px] text-accent">最新：{meta().latest}</p>
              </Show>
              <Show when={meta().updateTime}>
                <p class="text-[11px] text-text-3">更新：{meta().updateTime}</p>
              </Show>
              <Show when={alreadyOnShelf()}>
                <p class="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-accent-weak px-2 py-0.5 text-[11px] font-semibold text-accent">
                  <BookIcon size={12} />
                  已在书架
                </p>
              </Show>
            </div>
          </div>

          <Show when={meta().intro}>
            <p class="mt-4 rounded-[12px] border border-border bg-surface px-3.5 py-3 text-[12.5px] leading-[1.75] text-text-2">
              {meta().intro}
            </p>
          </Show>

          <Show when={error()}>
            <p class="mt-3 rounded-[10px] bg-danger-weak px-3 py-2 text-[12px] text-danger">
              {error()}
            </p>
          </Show>

          <div class="mt-5 space-y-2.5">
            <button
              class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-3 text-[14px] font-semibold text-on-accent active:scale-[0.98] disabled:opacity-50"
              disabled={adding()}
              onClick={() => void onAddToShelf(true)}
            >
              <Show when={adding()} fallback={<BookIcon size={17} />}>
                <RefreshIcon size={17} class="animate-spin" />
              </Show>
              {adding() ? "正在获取目录…" : alreadyOnShelf() ? "去书架阅读" : "加入书架并阅读"}
            </button>
            <p class="text-center text-[11px] leading-[1.6] text-text-3">
              加入书架只保存章节列表；正文在阅读时按需缓存「当前章与前后各 {LAZY_WINDOW} 章」，阅读页也可批量下载全部用于离线
            </p>
          </div>
        </div>
      </Show>
    </div>
  );
}
