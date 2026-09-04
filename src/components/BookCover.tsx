import { Show, createEffect, createMemo, createSignal } from "solid-js";
import { localBookById } from "../lib/books";

type CoverVariant = "grid" | "thumb" | "row";

interface BookCoverProps {
  /** 书籍 id（书籍数据由全局书库按 id 解析） */
  bookId: string;
  variant?: CoverVariant;
  label?: string;
}

/**
 * 书籍封面：
 * - EPUB 且在导入时提取到封面 → 展示真实封面缩略图；
 * - 其余（TXT / 无封面 EPUB / 在线书）→ 回退为程序化渐变封面
 *   （以书自身 hue 生成渐变底 + 书名 + 作者）。
 */
export function BookCover(props: BookCoverProps) {
  const variant = props.variant ?? "grid";
  const [imgFailed, setImgFailed] = createSignal(false);

  const book = createMemo(() => localBookById(props.bookId));
  const showCover = createMemo(() => {
    const b = book();
    return !!b && b.format === "epub" && !!b.cover && !imgFailed();
  });

  // 同一本书重新导入/数据刷新产生新记录实例时，重置上一次的加载失败状态以便重试
  createEffect((prevBook: ReturnType<typeof book> | undefined) => {
    const next = book();
    if (next !== prevBook) setImgFailed(false);
    return next;
  }, undefined);

  const hue = () => book()?.hue ?? 210;
  const background = () =>
    `linear-gradient(165deg, hsl(${hue()} 58% 52%), hsl(${(hue() + 24) % 360} 62% 34%))`;
  const variantClass =
    variant === "grid"
      ? "w-full"
      : variant === "row"
        ? "w-[66px] flex-none rounded-lg"
        : "";
  const baseClass =
    "relative flex aspect-[3/4] select-none flex-col items-center justify-center gap-1.5 overflow-hidden rounded-[10px] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_4px_10px_rgb(0_0_0/0.18)]";
  // 渐变封面的顶部高光只叠加在没有真实封面的兜底盒上，避免盖在图片上（响应式切换）
  const sheenClass = () =>
    showCover()
      ? ""
      : "after:pointer-events-none after:absolute after:inset-0 after:bg-[linear-gradient(180deg,rgb(255_255_255/0.16),transparent_34%)]";

  const formatLabel = () => {
    const format = book()?.format;
    return format === "online" ? "在线" : format ? format.toUpperCase() : "";
  };

  return (
    <div
      class={`${baseClass} ${variantClass} ${sheenClass()}`}
      style={{ background: background() }}
      role="img"
      aria-label={props.label ?? `${book()?.title ?? "书籍"}封面`}
    >
      <span class="absolute left-1.5 top-1.5 z-10 rounded-full bg-black/30 px-[5px] py-[2.5px] text-[9px] leading-none tracking-[0.08em]">
        {formatLabel()}
      </span>
      <Show when={book()}>
        <Show when={showCover()}>
          <img
            src={book()!.cover}
            alt=""
            draggable={false}
            class="absolute inset-0 h-full w-full object-cover"
            onError={() => setImgFailed(true)}
          />
        </Show>
        <Show when={!showCover()}>
          <span
            class="relative z-10 overflow-hidden text-center font-bold leading-none text-[12px] [text-shadow:0_2px_6px_rgb(0_0_0/0.2)] line-clamp-5"
          >
            {book()?.title}
          </span>
          <span class="relative z-10 max-w-[calc(100%-16px)] overflow-hidden text-ellipsis whitespace-nowrap text-[9.5px] leading-[1.2] text-white/85 tracking-[0.05em] line-clamp-1">
            {book()?.author}
          </span>
        </Show>
      </Show>
    </div>
  );
}
