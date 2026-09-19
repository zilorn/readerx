import { lazy, onMount, onCleanup, Show, createEffect } from "solid-js";
import type { Component } from "solid-js";
import { Router, Route, type RouteSectionProps } from "@solidjs/router";
import { Toasts } from "./components/Toasts";
import { GroupPicker } from "./components/GroupPicker";
import { MobileStage } from "./shell/MobileStage";
import { DesktopStage } from "./shell/DesktopStage";
import { bookMetaById, ensureLocalBooksLoaded } from "./lib/books";
import {
  assignBookGroup,
  closeGroupAssign,
  groupAssignBookId,
} from "./lib/groups";
import { isDesktopShell } from "./lib/platform";

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
 * 常驻（保活）页面：路径 → 组件。
 * 两个外壳（手机 / 桌面）共用这份注册表，各自按它挂载并常驻 DOM —— 切 Tab、进书再返回
 * 都不会重新挂载，页内的搜索词 / 结果列表 / 勾选 / 滚动位置原样保留（首页、发现页、
 * 设置页，以及「WebDAV 导入」：进书阅读返回后仍停在原目录与原位置）。
 * 因此它们不再出现在下面的路由表里：路由只声明真正会 push / pop 的次级页面。
 */
const KEPT_PAGES: Record<string, Component> = {
  "/": BookshelfPage,
  "/discover": DiscoverPage,
  "/settings": SettingsPage,
  "/webdav-import": WebdavImportPage,
};

/**
 * 根布局：外壳（手机：手机列 + 底部 Tab；桌面：侧边栏 + 内容区）+ 全局提示。
 * 滚动容器、导航与页面切换统一由外壳组件维护，此处只负责选外壳、全局 Toast，
 * 以及提示条「加入分组」拉起的移入分组抽屉（抽屉跨页面：入架后可能已跳到阅读页 /
 * 书架，故不能挂在发起入架的组件里）。
 */
const AppShell: Component<RouteSectionProps> = (props) => {
  return (
    <div
      class="relative mx-auto flex h-screen w-full flex-col overflow-hidden bg-bg"
      classList={{
        // 手机端（含桌面窗口拉窄到断点以下）：始终是居中的手机列
        "max-w-[var(--app-column)] min-[521px]:border-x min-[521px]:border-border min-[521px]:shadow-[0_0_44px_rgb(0_0_0/0.16)]":
          !isDesktopShell(),
        // 桌面端：铺满窗口，由侧边栏与内容区分栏
        "max-w-none": isDesktopShell(),
      }}
      style={{ height: "100dvh" }}
    >
      <Show
        when={isDesktopShell()}
        fallback={<MobileStage kept={KEPT_PAGES}>{props.children}</MobileStage>}
      >
        <DesktopStage kept={KEPT_PAGES}>{props.children}</DesktopStage>
      </Show>

      <Toasts />

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
      {/* 主 Tab（/ 、/discover 、/settings）与 /webdav-import 属常驻页面，见 KEPT_PAGES */}
      <Route path="/shelf-search" component={ShelfSearchPage} />
      <Route path="/chapter-rules" component={ChapterRulesPage} />
      <Route path="/tts-cache" component={TtsCachePage} />
      <Route path="/book/:id" component={ReaderPage} />
      <Route path="/sources" component={BookSourcesPage} />
      <Route path="/source-editor" component={SourceEditorPage} />
      <Route path="/online/:key" component={OnlineBookPage} />
      <Route path="/detail/:id" component={BookDetailPage} />
      <Route path="*404" component={NotFoundPage} />
    </Router>
  );
}

export default App;
