/**
 * 常驻（保活）页面的弹层收尾。
 *
 * 主 Tab（书架 / 发现 / 设置）与 WebDAV 导入页由 RouteStage 常驻挂载，切走时只是
 * `display:none`，页面自身不会卸载。挂在 <Portal> 上的弹层（弹窗 / 抽屉 / 底部菜单）
 * 是渲染到 document.body 的，不跟着页面层一起隐藏 —— 不收起来的话，离开本页后
 * 弹层会留在别的页面上挡住操作（例如打开 WebDAV 配置抽屉后用系统返回离开）。
 */
import { createEffect, on } from "solid-js";
import { useLocation } from "@solidjs/router";

/** 路由变化（离开本页 / 跳转）时收起本页弹层；首次挂载不触发 */
export function closeOnRouteChange(close: () => void): void {
  const location = useLocation();
  createEffect(
    on(
      () => location.pathname,
      () => close(),
      { defer: true },
    ),
  );
}
