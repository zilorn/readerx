import type { Book } from "../lib/mock";

type CoverVariant = "grid" | "thumb" | "row";

interface BookCoverProps {
  book: Book;
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
  return (
    <div
      class={`cover cover--${variant}`}
      style={{ background }}
      role="img"
      aria-label={props.label ?? `${book.title}封面`}
    >
      <span
        class={`cover__badge ${book.status === "连载" ? "cover__badge--live" : ""}`}
      >
        {book.status}
      </span>
      <span class="cover__glyph">{book.title.charAt(0)}</span>
      <span class="cover__author">{book.author}</span>
    </div>
  );
}
