import type { JSX } from "solid-js";

export interface DrawerProps {
  children: JSX.Element;
  onClose: () => void;
  label: string;
  /** 阅读器内浮层相对阅读区定位；全局浮层相对窗口定位。 */
  position?: "absolute" | "fixed";
  /** 遮罩层级，面板位于其上一层。 */
  layer?: number;
  /** 面板高度约束，默认 max-h-[72%]；右侧栏忽略此项。 */
  sizeClass?: string;
  class?: string;
  /** 标记阅读器浮层，避免其事件触发翻页手势。 */
  readerUi?: boolean;
  /** 桌面目录保留右侧栏布局，其余抽屉从底部展开。 */
  placement?: "bottom" | "right";
  panelRef?: (element: HTMLDivElement) => void;
}

/** 共用遮罩、定位、动画和对话框语义。挂载与 Portal 由调用方管理。 */
export function Drawer(props: DrawerProps) {
  const side = () => props.placement === "right";
  return (
    <>
      <div
        data-reader-ui={props.readerUi ? "" : undefined}
        class={`${props.position ?? "fixed"} inset-0 animate-sheet-fade ${side() ? "bg-black/20" : "bg-black/45 backdrop-blur-[2px]"}`}
        style={{ "z-index": props.layer ?? 50 }}
        onClick={props.onClose}
      />
      <div
        ref={(element) => props.panelRef?.(element)}
        data-reader-ui={props.readerUi ? "" : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        class={`${props.position ?? "fixed"} flex flex-col overflow-hidden bg-surface ${side()
          ? "inset-y-0 right-0 w-[380px] max-w-[86%] animate-sheet-in-right border-l border-border shadow-[-10px_0_34px_rgb(0_0_0/0.22)]"
          : `inset-x-0 bottom-0 mx-auto max-w-[var(--app-column)] animate-sheet-up rounded-t-[16px] shadow-[0_-10px_34px_rgb(0_0_0/0.22)] ${props.sizeClass ?? "max-h-[72%]"}`} ${props.class ?? ""}`}
        style={{ "z-index": (props.layer ?? 50) + 1 }}
      >
        {props.children}
      </div>
    </>
  );
}
