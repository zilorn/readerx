import { lazy, Suspense, Show, createEffect, createMemo, on, onMount } from "solid-js";
import type { Component } from "solid-js";
import { registerAppScrollEl } from "./lib/appScroll";
import {
  Router,
  Route,
  useLocation,
  type RouteSectionProps,
} from "@solidjs/router";
import { TabBar } from "./components/TabBar";
import { LoadingScreen } from "./components/LoadingScreen";
import { ensureLocalBooksLoaded } from "./lib/books";
import { currentToast } from "./lib/toast";
import { shelfSelectingMode } from "./lib/store";

// ---- 路由页面全部走代码分割 + 懒加载（配合 Suspense） ----
const BookshelfPage = lazy(() => import("./pages/Bookshelf"));
const ShelfSearchPage = lazy(() => import("./pages/ShelfSearch"));
const WebdavImportPage = lazy(() => import("./pages/WebdavImport"));
const DiscoverPage = lazy(() => import("./pages/Discover"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const ChapterRulesPage = lazy(() => import("./pages/ChapterRules"));
const TtsCachePage = lazy(() => import("./pages/TtsCache"));
const ReaderPage = lazy(() => import("./pages/Reader"));
const BookSourcesPage = lazy(() => import("./pages/BookSources"));
const SourceEditorPage = lazy(() => import("./pages/SourceEditor"));
const OnlineBookPage = lazy(() => import("./pages/OnlineBook"));
const BookDetailPage = lazy(() => import("./pages/BookDetail.tsx"));
const NotFoundPage = lazy(() => import("./pages/NotFound"));

/**
 * 根布局：包裹所有路由。
 * - <Suspense> 承接懒加载页面代码块未就绪时的 loading
 * - 书架 / 发现 / 设置三个主 Tab 页面显示底部导航
 */
const AppShell: Component<RouteSectionProps> = (props) => {
  const location = useLocation();

  // /book/:id、404 等次级页面隐藏底部 Tab
  const inMainTabs = createMemo(() => {
    const path = location.pathname;
    return path === "/" || path === "/discover" || path === "/settings";
  });

  // 书架多选时临时隐藏底部 Tab，把屏幕最底部让给“移动到分组 / 删除”操作条
  const tabBarHidden = createMemo(
    () => location.pathname === "/" && shelfSelectingMode(),
  );

  // 阅读页自行管理底部留白与分页高度，不套用统一的滚动区底部留白
  const isReader = createMemo(() => location.pathname.startsWith("/book/"));

  let viewRef: HTMLDivElement | undefined;
  // 注册唯一的内容滚动容器，供页面（如 WebDAV 导入页）保存/恢复滚动位置
  onMount(() => registerAppScrollEl(viewRef ?? null));
  // 路由切换后，让滚动容器回到顶部（避免切页后停留在旧滚动位置）
  createEffect(
    on(
      () => location.pathname,
      () => viewRef?.scrollTo({ top: 0 }),
    ),
  );

  return (
    <div
      class="relative mx-auto flex h-screen w-full max-w-[480px] flex-col overflow-hidden bg-bg min-[521px]:border-x min-[521px]:border-border min-[521px]:shadow-[0_0_44px_rgb(0_0_0/0.16)]"
      style={{ height: "100dvh" }}
    >
      <div
        ref={viewRef}
        class="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain scrollbar-none"
        classList={{
          // 内容页统一在滚动区底部默认留一点空位（阅读页自行排版，不套用）
          "pb-4": !isReader(),
        }}
      >
        <Suspense fallback={<LoadingScreen label="页面加载中…" />}>
          {props.children}
        </Suspense>
      </div>
      <Show when={inMainTabs() && !tabBarHidden()}>
        <TabBar />
      </Show>
      <Show when={currentToast()}>
        {(toast) => (
          <div
            class="absolute bottom-[calc(84px+env(safe-area-inset-bottom))] left-1/2 z-[60] max-w-[calc(100%-48px)] animate-toast-in rounded-full px-4 py-[9px] text-center text-[13px] leading-[1.4] shadow-lg shadow-black/20 [transform:translateX(-50%)]"
            classList={{
              "bg-text text-bg": !toast().error,
              "bg-danger text-white": toast().error,
            }}
            role="status"
          >
            {toast().text}
          </div>
        )}
      </Show>
    </div>
  );
};

function App() {
  // 尽早载入本地书库（幂等），让书架/阅读页直接消费响应式数据
  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  return (
    <Router root={AppShell}>
      <Route path="/" component={BookshelfPage} />
      <Route path="/shelf-search" component={ShelfSearchPage} />
      <Route path="/webdav-import" component={WebdavImportPage} />
      <Route path="/discover" component={DiscoverPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/chapter-rules" component={ChapterRulesPage} />
      <Route path="/tts-cache" component={TtsCachePage} />
      <Route path="/book/:id" component={ReaderPage} />
      <Route path="/sources" component={BookSourcesPage} />
      <Route path="/source-editor" component={SourceEditorPage} />
      <Route path="/online/:key" component={OnlineBookPage} />
      <Route path="/detail/:id" component={BookDetailPage}/>
      <Route path="*404" component={NotFoundPage} />
    </Router>
  );
}

export default App;
