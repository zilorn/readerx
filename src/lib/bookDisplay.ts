/**
 * 书库兜底元数据的显示层翻译。
 *
 * 导入时书名 / 作者缺失会写入兜底值（`未命名书籍` / `佚名`，与 `src-tauri/src/models.rs`
 * 同口径），它们是**落库数据**：存量书库里已经写死中文，换界面语言也不会重写，
 * 而 `pagination.ts`、`online.ts`、`Reader.tsx` 等处还要拿这两个值做判断。
 *
 * 因此这里不动数据，只在**显示**时把它们（以及空值）换成当前语言的文案；
 * 落库、比较、搜索一律继续用原值。
 */
import { t } from "./i18n";

/** 落库的兜底书名（历史与当前口径都是中文） */
export const FALLBACK_BOOK_TITLE = "未命名书籍";
/** 落库的兜底作者名 */
export const FALLBACK_BOOK_AUTHOR = "佚名";

/** 书名是否为空或落库兜底值（用于判断「这本书没有真书名」） */
export function isFallbackBookTitle(title: string | null | undefined): boolean {
  const value = (title ?? "").trim();
  return value.length === 0 || value === FALLBACK_BOOK_TITLE;
}

/** 作者是否为空或落库兜底值（用于判断「这本书没有真作者」） */
export function isFallbackBookAuthor(author: string | null | undefined): boolean {
  const value = (author ?? "").trim();
  return value.length === 0 || value === FALLBACK_BOOK_AUTHOR;
}

/** 显示用书名：兜底值 / 空值换成当前语言，其余原样 */
export function bookDisplayTitle(title: string | null | undefined): string {
  return isFallbackBookTitle(title)
    ? t("common.unnamedBook")
    : (title as string);
}

/** 显示用作者名：兜底值 / 空值换成当前语言，其余原样 */
export function bookDisplayAuthor(author: string | null | undefined): string {
  return isFallbackBookAuthor(author)
    ? t("common.anonymousAuthor")
    : (author as string);
}
