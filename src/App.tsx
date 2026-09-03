import { lazy, Suspense, Show, createEffect, createMemo, on } from "solid-js";
import type { Component } from "solid-js";
import {
  Router,
  Route,
  useLocation,
  type RouteSectionProps,
} from "@solidjs/router";
import { TabBar } from "./components/TabBar";
import { LoadingScreen } from "./components/LoadingScreen";

// ---- 路由页面全部走代码分割 + 懒加载（配合 Suspense） ----
const BookshelfPage = lazy(() => import("./pages/Bookshelf"));
const DiscoverPage = lazy(() => import("./pages/Discover"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const ReaderPage = lazy(() => import("./pages/Reader"));
const NotFoundPage = lazy(() => import("./pages/NotFound"));

/**
 * 根布局：包裹所有路由。
 * - <Suspense> 承接懒加载页面代码块未就绪时的 loading
 * - 只有书架/发现/设置三个主 Tab 页面显示底部导航
 */
const AppShell: Component<RouteSectionProps> = (props) => {
  const location = useLocation();

  // /book/:id、404 等次级页面隐藏底部 Tab
  const inMainTabs = createMemo(() => {
    const path = location.pathname;
    return path === "/" || path === "/discover" || path === "/settings";
  });

  let viewRef: HTMLDivElement | undefined;
  // 路由切换后，让滚动容器回到顶部（避免切页后停留在旧滚动位置）
  createEffect(
    on(
      () => location.pathname,
      () => viewRef?.scrollTo({ top: 0 }),
    ),
  );

  return (
    <div class="app">
      <div class="app-view" ref={viewRef}>
        <Suspense fallback={<LoadingScreen label="页面加载中…" />}>
          {props.children}
        </Suspense>
      </div>
      <Show when={inMainTabs()}>
        <TabBar />
      </Show>
    </div>
  );
};

function App() {
  return (
    <Router root={AppShell}>
      <Route path="/" component={BookshelfPage} />
      <Route path="/discover" component={DiscoverPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/book/:id" component={ReaderPage} />
      <Route path="*404" component={NotFoundPage} />
    </Router>
  );
}

export default App;
