/**
 * 可点击的书名 / 作者文本：点击即回调该词，由调用方发起一次全源快速搜索
 * （书籍详情页与在线书详情抽屉共用，两处口径一致）。
 * 文字本身不变，末尾的放大镜是「点这里能搜」的提示；不传 onSearch 时退化为纯文本。
 */
import { Show } from "solid-js";
import { SearchIcon } from "./icons";

export interface QuickSearchTextProps {
  /** 参与搜索的词（展示用的简繁转换副本，看到什么就搜什么） */
  text: string;
  /** 无障碍名称前缀，如「搜索书名」 */
  action: string;
  /** 文字自身的排版类：默认按宽度换行，单行省略的场景传 truncate */
  textClass?: string;
  iconSize: number;
  /** 放大镜的上边距：按所在行字号给，使图标与本行文字居中对齐 */
  iconClass: string;
  /** 不提供则只展示文字，不可点 */
  onSearch?: (text: string) => void;
}

export function QuickSearchText(props: QuickSearchTextProps) {
  const textClass = () => `min-w-0 ${props.textClass ?? "break-words"}`;
  return (
    <Show
      when={props.onSearch}
      fallback={<span class={textClass()}>{props.text}</span>}
    >
      {(onSearch) => (
        <button
          type="button"
          class="inline-flex max-w-full items-start gap-1 text-left transition-opacity duration-150 active:opacity-55"
          aria-label={`${props.action}：${props.text}`}
          onClick={() => onSearch()(props.text)}
        >
          <span class={textClass()}>{props.text}</span>
          <SearchIcon
            size={props.iconSize}
            class={`flex-none text-text-3/70 ${props.iconClass}`}
          />
        </button>
      )}
    </Show>
  );
}
