/**
 * 页面正文容器：滚动区 + 懒加载 fallback。
 *
 * 两个外壳（手机 [`MobileStage`](../shell/MobileStage.tsx) / 桌面 `DesktopStage`）共用它，
 * 保证「懒加载页面」在两种布局下的加载表现一致（同一套 `data-stage-loading` 标记，
 * 手机外壳据此判断新页是否已经渲染出来、可以开始过渡动画）。
 */
import { Suspense, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ScrollArea } from "./ScrollArea";
import { LoadingScreen } from "./LoadingScreen";

export interface PageBodyProps {
  /** 常驻（保活）页面组件；与 children 互斥 */
  component?: Component;
  /** 瞬态页面：路由出口内容 */
  children?: JSX.Element;
  /** 是否渲染路由出口（离场中的层不渲染：出口是共享快照，抢 DOM） */
  renderChildren?: boolean;
  /** 额外加在内容区的类（底部留白 / 桌面居中限宽等） */
  contentClass?: string;
  /** 真正滚动元素回传（注册全局滚动容器 / 恢复滚动位置） */
  onScrollEl?: (el: HTMLDivElement) => void;
}

export function PageBody(props: PageBodyProps) {
  return (
    <ScrollArea class="min-h-0 flex-1" contentClass={props.contentClass} onEl={props.onScrollEl}>
      <Suspense
        fallback={
          <div class="h-full" data-stage-loading="true">
            <LoadingScreen label="页面加载中…" />
          </div>
        }
      >
        {props.component ? <Dynamic component={props.component} /> : null}
        {!props.component && (props.renderChildren ?? true) ? props.children : null}
      </Suspense>
    </ScrollArea>
  );
}
