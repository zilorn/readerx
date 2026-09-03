import type { JSX } from "solid-js";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** 标题右侧操作区 */
  right?: JSX.Element;
  /** 标题下方内容（如搜索框、分类筛选） */
  children?: JSX.Element;
}

/** 主 Tab 页通用页头（吸顶） */
export function PageHeader(props: PageHeaderProps) {
  return (
    <header class="topbar">
      <div class="topbar__inner">
        <div class="topbar__titles">
          <h1 class="topbar__title">{props.title}</h1>
          {props.subtitle && (
            <span class="topbar__subtitle">{props.subtitle}</span>
          )}
        </div>
        {props.right}
      </div>
      {props.children}
    </header>
  );
}
