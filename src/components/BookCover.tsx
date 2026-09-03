type CoverVariant = "grid" | "thumb" | "row";

interface BookCoverProps {
  book: {
    title: string;
    author: string;
    hue: number;
    format: string;
  };
  variant?: CoverVariant;
  label?: string;
}

/**
 * 无封面图阶段的程序化封面：
 * 以书自身 hue 生成渐变底 + 书名首字 + 作者。
 */
export function BookCover(props: BookCoverProps) {
  const { book } = props;
  const variant = props.variant ?? "grid";
  const background = `linear-gradient(165deg, hsl(${book.hue} 58% 52%), hsl(${(book.hue + 24) % 360} 62% 34%))`;
  const variantClass =
    variant === "grid"
      ? "w-full"
      : variant === "row"
        ? "w-[66px] flex-none rounded-lg"
        : "";
  const glyphSize =
    variant === "grid" ? "text-[46px]" : variant === "row" ? "text-[28px]" : "text-[36px]";
  return (
    <div
      class={`relative flex aspect-[3/4] select-none flex-col items-center justify-center gap-1.5 overflow-hidden rounded-[10px] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_4px_10px_rgb(0_0_0/0.18)] after:pointer-events-none after:absolute after:inset-0 after:bg-[linear-gradient(180deg,rgb(255_255_255/0.16),transparent_34%)] ${variantClass}`}
      style={{ background }}
      role="img"
      aria-label={props.label ?? `${book.title}封面`}
    >
      <span class="absolute left-1.5 top-1.5 z-10 rounded-full bg-black/30 px-[5px] py-[2.5px] text-[9px] leading-none tracking-[0.08em]">
        {book.format.toUpperCase()}
      </span>
      <span
        class={`relative z-10 font-bold leading-none [text-shadow:0_2px_6px_rgb(0_0_0/0.2)] ${glyphSize}`}
      >
        {book.title.charAt(0)}
      </span>
      <span class="relative z-10 max-w-[calc(100%-16px)] overflow-hidden text-ellipsis whitespace-nowrap text-[9.5px] leading-[1.2] text-white/85 tracking-[0.05em]">
        {book.author}
      </span>
    </div>
  );
}
