import { lazy, onMount, onCleanup, Show, createEffect } from "solid-js";
import type { Component } from "solid-js";
import { Router, Route, type RouteSectionProps } from "@solidjs/router";
import { RouteStage } from "./components/RouteStage";
import { GroupPicker } from "./components/GroupPicker";
import { bookMetaById, ensureLocalBooksLoaded } from "./lib/books";
import {
  assignBookGroup,
  closeGroupAssign,
  groupAssignBookId,
} from "./lib/groups";
import { currentToast, dismissToast } from "./lib/toast";

// ---- 路由页面全部走代码分割 + 懒加载（配合页面栈内 Suspense） ----
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
 * 根布局：外层手机列 + 页面栈 RouteStage。
 * 滚动容器、底部 Tab 与页面切换动画统一由 RouteStage 以「页面层」维护，
 * 此处只保留外壳、全局 Toast，以及提示条「加入分组」拉起的移入分组抽屉
 * （抽屉跨页面：入架后可能已跳到阅读页 / 书架，故不能挂在发起入架的组件里）。
 */
const AppShell: Component<RouteSectionProps> = (props) => {
  return (
    <div
      class="relative mx-auto flex h-screen w-full max-w-[480px] flex-col overflow-hidden bg-bg min-[521px]:border-x min-[521px]:border-border min-[521px]:shadow-[0_0_44px_rgb(0_0_0/0.16)]"
      style={{ height: "100dvh" }}
    >
      <RouteStage>{props.children}</RouteStage>
      <Show when={currentToast()}>
        {(toast) => (
          <div
            class="absolute bottom-[calc(84px+env(safe-area-inset-bottom))] left-1/2 z-[95] max-w-[calc(100%-48px)] animate-toast-in text-[13px] leading-[1.4] shadow-lg shadow-black/20 [transform:translateX(-50%)]"
            classList={{
              "rounded-full px-4 py-[9px] text-center": !toast().action,
              "bg-text text-bg": !toast().action && !toast().error,
              "bg-danger text-white": !toast().action && toast().error,
              "flex items-center gap-1.5 rounded-[14px] border border-border bg-surface py-1.5 pl-3.5 pr-1.5 text-text":
                !!toast().action,
            }}
            role={toast().error ? "alert" : "status"}
          >
            <span class="min-w-0">{toast().text}</span>
            <Show when={toast().action}>
              {(action) => (
                <button
                  class="flex-none rounded-[10px] bg-accent-weak px-2.5 py-1 font-semibold text-accent transition-[scale,opacity] duration-100 active:scale-[0.96] active:opacity-80"
                  onClick={() => {
                    const run = action().onClick;
                    dismissToast();
                    run();
                  }}
                >
                  {action().label}
                </button>
              )}
            </Show>
          </div>
        )}
      </Show>

      {/* 入架提示里的「加入分组」：移入分组抽屉 */}
      <Show when={groupAssignBookId()}>
        {(bookId) => (
          <GroupPicker
            value={bookMetaById(bookId())?.groupId ?? null}
            onSelect={(groupId) => {
              void assignBookGroup(bookId(), groupId);
            }}
            onClose={closeGroupAssign}
          />
        )}
      </Show>
    </div>
  );
};

function App() {
  // 尽早载入本地书库（幂等），让书架/阅读页直接消费响应式数据。
  // 注意：这里不能阻塞首帧 —— index.tsx 的首帧只等轻量偏好，
  // 本 effect 在首帧之后跑，书架页在数据就绪前显示加载占位。
  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  // 预热其它主 Tab 页面块（Discover / Settings），让切 Tab 时正文即刻可渲染、
  // 页面切换动画（淡入淡出）不先空白。预热放到首帧交互之后（延迟执行），
  // 避免与书架首次渲染/书库加载抢解析时间；首页自身的块由路由按需加载。
  onMount(() => {
    const warmupTimer = window.setTimeout(() => {
      void import("./pages/Discover");
      void import("./pages/Settings");
    }, 1500);
    onCleanup(() => window.clearTimeout(warmupTimer));
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
