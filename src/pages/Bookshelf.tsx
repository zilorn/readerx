import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { BookCover } from "../components/BookCover";
import { GroupManagerSheet } from "../components/GroupManager";
import { GroupPicker } from "../components/GroupPicker";
import { LoadingScreen } from "../components/LoadingScreen";
import { PageHeader } from "../components/PageHeader";
import { ImportButton } from "../components/ImportButton";
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  LibraryIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "../components/icons";
import {
  ensureLocalBooksLoaded,
  bookMetaById,
  bookMetasReady,
  removeLocalBook,
  setLocalBookGroup,
} from "../lib/books";
import {
  bookSourceOf,
  type BookMeta,
  type BookSource,
} from "../lib/booksTypes";
import { withHanMeta } from "../lib/hanDisplay";
import {
  groupDisplayName,
  groupList,
  HIDDEN_GROUP_ID,
  isHiddenGroupId,
} from "../lib/groups";
import { t } from "../lib/i18n";
import { metaCardStatus } from "../lib/progress";
import {
  lastShelfFilterKey,
  removeShelfEntry,
  rememberShelfFilter,
  setShelfSelecting,
  shelfOrder,
  shelfSourceFilterEnabled,
  type ShelfEntry,
} from "../lib/store";
import { bookDisplayTitle } from "../lib/bookDisplay";

interface ShelfItem {
  entry: ShelfEntry;
  book: BookMeta;
}

/**
 * 书架筛选（互斥单选，不可叠加）：
 * - all    ：无筛选（全部在架书，不含归入隐藏分组的书）
 * - source ：只看某一来源（本地 / WebDAV / 在线）
 * - group  ：只看某一分组（含内置「隐藏」分组）
 */
type ShelfFilter =
  | { kind: "all" }
  | { kind: "source"; source: BookSource }
  | { kind: "group"; groupId: string };

/** 该分组 id 是否为内置隐藏分组（其 tag 排在自定义分组前） */
function isHiddenGroup(groupId: string): boolean {
  return groupId === HIDDEN_GROUP_ID;
}

/**
 * 把记忆的筛选标签 key（all / local / webdav / online / group-<id>）还原为筛选条件。
 * 目标分组已被删除（内置隐藏分组除外）/ 来源未知时回落「全部」，避免指向不存在的 chip。
 */
function restoreShelfFilter(key: string): ShelfFilter {
  if (key === "local" || key === "webdav" || key === "online") {
    return { kind: "source", source: key };
  }
  if (key.startsWith("group-")) {
    const groupId = key.slice("group-".length);
    if (
      groupId === HIDDEN_GROUP_ID ||
      groupList().some((group) => group.id === groupId)
    ) {
      return { kind: "group", groupId };
    }
  }
  return { kind: "all" };
}

/**
 * 按“正文文本位置”计算进度（基于书库元数据的章节字符数，不物化整书）：
 * 已读章节累计字符 + 当前章节内偏移 → 整书百分比。
 */
function cardProgress(entry: ShelfEntry, book: BookMeta): {
  hasRead: boolean;
  finished: boolean;
  percent: number;
} {
  return metaCardStatus(book, entry);
}

/** 单本书卡片：支持单击打开、长按进入多选、选中状态下点击切换选中 */
function BookCard(props: {
  item: ShelfItem;
  selectMode: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onLongPress: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { entry, book } = props.item;
  const { hasRead, finished, percent } = cardProgress(entry, book);
  /** 兜底书名只在显示时翻译（书库里的默认书名是持久化值，见 lib/bookDisplay.ts） */
  const title = () => bookDisplayTitle(book.title);

  let longPressTimer: number | undefined;
  let longPressFired = false;
  let downX = 0;
  let downY = 0;

  function onPointerDown(e: PointerEvent) {
    longPressFired = false;
    downX = e.clientX;
    downY = e.clientY;
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      if (!props.selectMode) props.onLongPress(book.id);
    }, 480);
  }

  function onPointerMove(e: PointerEvent) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 12) {
      window.clearTimeout(longPressTimer);
    }
  }

  function cancelLongPress() {
    window.clearTimeout(longPressTimer);
  }

  function onClick() {
    if (longPressFired) return;
    if (props.selectMode) props.onToggle(book.id);
    else props.onOpen(book.id);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (props.selectMode) props.onToggle(book.id);
    else props.onOpen(book.id);
  }

  return (
    <div
      class="flex w-full select-none flex-col items-start gap-[5px] text-left touch-manipulation"
      role="button"
      tabindex={0}
      aria-label={
        props.selectMode
          ? props.selected
            ? t("shelf.deselectBookAria", { title: title() })
            : t("shelf.selectBookAria", { title: title() })
          : t("shelf.openAria", { title: title() })
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={(e) => e.preventDefault()}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div class="relative w-full rounded-[10px]">
        <BookCover bookId={book.id} variant="grid" />
        <Show when={props.selectMode && props.selected}>
          <span class="absolute right-[5px] top-[5px] z-[2] grid h-[26px] w-[26px] animate-pop-in place-items-center rounded-full bg-accent text-on-accent shadow-md">
            <CheckIcon size={15} />
          </span>
          <span class="pointer-events-none absolute inset-0 rounded-[10px] ring-2 ring-accent" />
        </Show>
      </div>
      <span class="max-w-full truncate text-[13.5px] font-semibold">
        {title()}
      </span>
      <Show when={hasRead}>
        <span
          class={`text-[11px] font-medium ${
            finished ? "text-success" : "text-accent"
          }`}
        >
          {finished
            ? t("shelf.progress.finished")
            : t("shelf.progress.percent", { percent })}
        </span>
        <span class="h-[3px] w-full overflow-hidden rounded-[2px] bg-surface-2" aria-hidden="true">
          <i
            class="block h-full rounded-[2px] bg-accent transition-[width] duration-200"
            style={{ width: `${finished ? 100 : percent}%` }}
          />
        </span>
      </Show>
    </div>
  );
}

interface ShelfGridProps {
  items: ShelfItem[];
  selectMode: boolean;
  selectedIds: string[];
  onOpen: (id: string) => void;
  onLongPress: (id: string) => void;
  onToggle: (id: string) => void;
}

/**
 * 书架网格：封面固定宽度 96px（改宽度就改这里的 `auto-fill` 轨道值），
 * **每行放几本由容器宽度决定**（`auto-fill` 按 96px 轨道尽量铺满一行），不再写死三列；
 * 轨道整体居中（`justify-center`），余量均分到两侧，窄窗口到宽窗口都是同一套规则：
 * 封面尺寸不变，只是每行本数增减。
 */
function ShelfGrid(props: ShelfGridProps) {
  return (
    <div class="grid grid-cols-[repeat(auto-fill,96px)] justify-center gap-x-3.5 gap-y-[22px] py-[2px] pb-1.5">
      <For each={props.items}>
        {(item) => (
          <BookCard
            item={item}
            selectMode={props.selectMode}
            selected={props.selectedIds.includes(item.book.id)}
            onOpen={props.onOpen}
            onLongPress={props.onLongPress}
            onToggle={props.onToggle}
          />
        )}
      </For>
    </div>
  );
}

function GroupChip(props: {
  label: string;
  active: boolean;
  count: number;
  onClick: () => void;
  onLongPress?: () => void;
}) {
  let longPressTimer: number | undefined;
  let longPressFired = false;
  let downX = 0;
  let downY = 0;
  let downEl: HTMLElement | undefined;
  let downPointerId = -1;

  function releaseCapture() {
    if (!downEl || downPointerId < 0) return;
    try {
      if (downEl.hasPointerCapture(downPointerId))
        downEl.releasePointerCapture(downPointerId);
    } catch {
      /* 指针已失效时忽略 */
    }
    downEl = undefined;
    downPointerId = -1;
  }

  function onPointerDown(e: PointerEvent) {
    if (!props.onLongPress) return;
    longPressFired = false;
    downX = e.clientX;
    downY = e.clientY;
    downEl = e.currentTarget as HTMLElement;
    downPointerId = e.pointerId;
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      if (!props.onLongPress || !downEl) return;
      // 长按触发后捕获指针：后续 pointerup/click 落在本 chip，
      // 避免点到新弹出的管理面板遮罩导致立即关闭
      try {
        downEl.setPointerCapture(downPointerId);
      } catch {
        /* 指针已失效时忽略 */
      }
      longPressFired = true;
      props.onLongPress();
    }, 480);
  }

  function onPointerMove(e: PointerEvent) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 12) {
      window.clearTimeout(longPressTimer);
    }
  }

  function cancelLongPress() {
    window.clearTimeout(longPressTimer);
  }

  function onPointerUp() {
    if (longPressFired) return; // 保留捕获，交给 onClick 消化并释放
    cancelLongPress();
    releaseCapture();
  }

  function onPointerCancel() {
    cancelLongPress();
    longPressFired = false;
    releaseCapture();
  }

  function onClick() {
    if (longPressFired) {
      longPressFired = false;
      releaseCapture();
      return;
    }
    props.onClick();
  }

  return (
    <button
      class="inline-flex flex-none select-none items-center gap-1.5 rounded-full px-3.5 py-[7px] text-[13px] touch-manipulation transition-colors duration-150"
      classList={{
        "bg-accent text-on-accent font-semibold": props.active,
        "bg-surface text-text-2 border border-border": !props.active,
      }}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
      {...(props.onLongPress
        ? {
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            onPointerLeave: cancelLongPress,
          }
        : {})}
    >
      {props.label}
      <span class={props.active ? "text-on-accent/80" : "text-text-3"}>{props.count}</span>
    </button>
  );
}

export default function BookshelfPage() {
  const navigate = useNavigate();
  // 初始筛选标签还原上次记忆的选择（进入书架即停留在上次的标签上）
  const [filter, setFilter] = createSignal<ShelfFilter>(
    restoreShelfFilter(lastShelfFilterKey()),
  );
  const [selecting, setSelecting] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
  const [groupPickerOpen, setGroupPickerOpen] = createSignal(false);
  const [groupManageOpen, setGroupManageOpen] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  let confirmTimer: number | undefined;

  onCleanup(() => {
    window.clearTimeout(confirmTimer);
    // 离开书架（页面卸载）时兜底复位，避免 AppShell 一直隐藏底部 Tab
    setShelfSelecting(false);
  });

  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  // 书架卡片读显示副本：简繁转换只改书名 / 作者 / 简介 / 标签，其余字段（来源、分组、章节数）原样
  const items = createMemo<ShelfItem[]>(() =>
    shelfOrder()
      .map((entry) => {
        const book = bookMetaById(entry.bookId);
        return book ? { entry, book: withHanMeta(book) ?? book } : null;
      })
      .filter((item): item is ShelfItem => item !== null),
  );

  /** 归入内置「隐藏」分组的书：只在隐藏分组里可见，其余视图全部排除 */
  const hiddenItems = createMemo<ShelfItem[]>(() =>
    items().filter((item) => isHiddenGroupId(item.book.groupId)),
  );

  /** 常规视图底集：隐藏分组的书之外的其它在架书 */
  const shelfItems = createMemo<ShelfItem[]>(() =>
    items().filter((item) => !isHiddenGroupId(item.book.groupId)),
  );

  /** 各来源在架书数（隐藏分组的书不参与来源计数） */
  const sourceCounts = createMemo<Record<BookSource, number>>(() => {
    const counts: Record<BookSource, number> = { local: 0, webdav: 0, online: 0 };
    for (const item of shelfItems()) counts[bookSourceOf(item.book)]++;
    return counts;
  });

  /** 是否存在非本地来源的在架书（WebDAV / 在线），决定来源筛选 chips 是否出现 */
  const hasNonLocalBooks = createMemo(
    () => sourceCounts().webdav > 0 || sourceCounts().online > 0,
  );

  /** 来源筛选 chips 是否可见：需要书架里有云端 / 在线书，且用户未在设置里关闭 */
  const showSourceChips = createMemo(
    () => shelfSourceFilterEnabled() && hasNonLocalBooks(),
  );

  /** 各自定义分组在架书数（隐藏分组的书不参与分组计数） */
  const groupCounts = createMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const item of shelfItems()) {
      const gid = item.book.groupId ?? null;
      if (gid) counts[gid] = (counts[gid] ?? 0) + 1;
    }
    return counts;
  });

  /**
   * 实际生效的筛选：所选来源已无书 / 所选自定义分组已被删除 / 隐藏分组已无书时
   * 回到「全部」，避免筛选指向一个已经不存在的 chip。
   */
  const activeFilter = createMemo<ShelfFilter>(() => {
    const f = filter();
    if (!showSourceChips() && f.kind === "source") return { kind: "all" };
    if (f.kind === "source" && sourceCounts()[f.source] === 0) return { kind: "all" };
    if (f.kind === "group") {
      if (isHiddenGroup(f.groupId)) {
        if (hiddenItems().length === 0) return { kind: "all" };
      } else if (!groupList().some((group) => group.id === f.groupId)) {
        return { kind: "all" };
      }
    }
    return f;
  });

  /** 当前可见书架（按单一筛选条件，来源与分组不可叠加） */
  const visibleItems = createMemo(() => {
    const f = activeFilter();
    if (f.kind === "group" && isHiddenGroup(f.groupId)) return hiddenItems();
    if (f.kind === "source")
      return shelfItems().filter((item) => bookSourceOf(item.book) === f.source);
    if (f.kind === "group")
      return shelfItems().filter((item) => (item.book.groupId ?? null) === f.groupId);
    return shelfItems();
  });

  /** 空态特例：书架里有书，但当前「全部」下只剩隐藏分组的书（引导去隐藏分组） */
  const allHiddenOnly = createMemo(
    () =>
      activeFilter().kind === "all" &&
      items().length > 0 &&
      hiddenItems().length > 0 &&
      shelfItems().length === 0,
  );

  /** 顶部筛选 chip：来源在前、分组在后，整行互斥单选 */
  interface FilterChip {
    key: string;
    label: string;
    count: number;
    value: ShelfFilter;
  }
  const filterChips = createMemo<FilterChip[]>(() => {
    const chips: FilterChip[] = [];
    const groups = groupList();
    const hiddenCount = hiddenItems().length;
    // 没有来源筛选、自定义分组也没有隐藏书时，筛选条整体不出现：
    // 关闭来源筛选或书架只有本地书时等同「只有本地」，此时「全部」仅随分组一起出现
    if (!showSourceChips() && groups.length === 0 && hiddenCount === 0) return chips;
    chips.push({
      key: "all",
      label: t("common.all"),
      count: shelfItems().length,
      value: { kind: "all" },
    });
    if (showSourceChips()) {
      const counts = sourceCounts();
      const options: { key: string; label: string; source: BookSource }[] = [
        { key: "local", label: t("shelf.source.local"), source: "local" },
        { key: "webdav", label: "WebDAV", source: "webdav" },
        { key: "online", label: t("shelf.source.online"), source: "online" },
      ];
      // 没有该来源的在架书就不显示对应 chip
      for (const option of options) {
        if (counts[option.source] > 0) {
          chips.push({
            key: option.key,
            label: option.label,
            count: counts[option.source],
            value: { kind: "source", source: option.source },
          });
        }
      }
    }
    // 内置隐藏分组 tag：有隐藏书时出现，排在自定义分组之前
    if (hiddenCount > 0) {
      chips.push({
        key: `group-${HIDDEN_GROUP_ID}`,
        label: groupDisplayName(HIDDEN_GROUP_ID),
        count: hiddenCount,
        value: { kind: "group", groupId: HIDDEN_GROUP_ID },
      });
    }
    for (const group of groups) {
      chips.push({
        key: `group-${group.id}`,
        label: group.name,
        count: groupCounts()[group.id] ?? 0,
        value: { kind: "group", groupId: group.id },
      });
    }
    return chips;
  });

  /** 当前生效筛选对应的 chip key（all / local / webdav / online / group-<id>） */
  const activeChipKey = createMemo(() => {
    const f = activeFilter();
    if (f.kind === "group") return `group-${f.groupId}`;
    if (f.kind === "source") return f.source;
    return "all";
  });

  function isChipActive(key: string): boolean {
    return key === activeChipKey();
  }

  const openBook = (id: string) => navigate(`/book/${id}`);

  function toggleSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  /** 当前筛选下是否所有可见书都已选中（决定「全选」按钮文案） */
  function allVisibleSelected(): boolean {
    const items = visibleItems();
    return items.length > 0 && items.every((item) => selectedIds().includes(item.book.id));
  }

  /** 全选 / 取消全选：只作用于当前筛选可见的书（隐藏项保持不动） */
  function toggleSelectAll() {
    const ids = visibleItems().map((item) => item.book.id);
    if (ids.length === 0) return;
    setSelectedIds((prev) => {
      if (allVisibleSelected()) {
        const drop = new Set(ids);
        return prev.filter((id) => !drop.has(id));
      }
      const merged = new Set(prev);
      for (const id of ids) merged.add(id);
      return [...merged];
    });
  }

  function onLongPress(id: string) {
    if (!selecting()) {
      setSelecting(true);
      setShelfSelecting(true);
      setConfirmDelete(false);
      setGroupPickerOpen(false);
    }
    toggleSelect(id);
  }

  function cancelSelect() {
    setSelecting(false);
    setShelfSelecting(false);
    setSelectedIds([]);
    setConfirmDelete(false);
    setGroupPickerOpen(false);
  }

  async function deleteSelected() {
    const ids = selectedIds();
    for (const id of ids) {
      try {
        await removeLocalBook(id);
        removeShelfEntry(id);
      } catch {
        /* 单本失败不影响其它 */
      }
    }
    cancelSelect();
  }

  async function moveSelectedToGroup(groupId: string | null) {
    const ids = selectedIds();
    for (const id of ids) {
      await setLocalBookGroup(id, groupId);
    }
    cancelSelect();
  }

  function sharedGroup(): string | null | undefined {
    const ids = selectedIds();
    if (ids.length === 0) return undefined;
    const groups = ids.map((id) => bookMetaById(id)?.groupId ?? null);
    return groups.every((g) => g === groups[0]) ? groups[0] : undefined;
  }

  function onRequestDelete() {
    if (selectedIds().length === 0) return;
    if (!confirmDelete()) {
      setConfirmDelete(true);
      window.clearTimeout(confirmTimer);
      confirmTimer = window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    window.clearTimeout(confirmTimer);
    setConfirmDelete(false);
    void deleteSelected();
  }

  const selectedCount = () => selectedIds().length;

  return (
    <div class="page relative select-none">
      <PageHeader
        title={selecting() ? t("shelf.select.title") : t("shelf.title")}
        subtitle={
          selecting()
            ? t("shelf.select.count", { count: selectedCount() })
            : visibleItems().length > 0
              ? t("shelf.onShelfCount", { count: visibleItems().length })
              : undefined
        }
        right={
          selecting() ? (
            <div class="flex flex-none items-center gap-0.5">
              <button
                class="h-10 rounded-xl px-2.5 text-[13.5px] font-medium text-accent transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2 disabled:opacity-35"
                aria-label={
                  allVisibleSelected()
                    ? t("shelf.select.noneAria")
                    : t("shelf.select.allAria")
                }
                disabled={visibleItems().length === 0}
                onClick={toggleSelectAll}
              >
                {allVisibleSelected()
                  ? t("common.deselectAll")
                  : t("common.selectAll")}
              </button>
              <button
                class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                aria-label={t("shelf.select.exitAria")}
                onClick={cancelSelect}
              >
                <CloseIcon />
              </button>
            </div>
          ) : (
            <div class="flex flex-none items-center gap-1">
              <button
                class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                aria-label={t("shelf.searchAria")}
                onClick={() => navigate("/shelf-search")}
              >
                <SearchIcon />
              </button>
              <ImportButton
                class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                ariaLabel={t("shelf.import.title")}
              >
                <PlusIcon />
              </ImportButton>
            </div>
          )
        }
      >
        <Show when={filterChips().length > 0}>
          <div class="m-0.5 flex gap-2 overflow-x-auto px-[18px] pb-1.5 pt-2 scrollbar-none">
            <For each={filterChips()}>
              {(chip) => (
                <GroupChip
                  label={chip.label}
                  active={isChipActive(chip.key)}
                  count={chip.count}
                  onClick={() => {
                    setFilter(chip.value);
                    rememberShelfFilter(chip.key);
                  }}
                  onLongPress={
                    chip.value.kind === "group" &&
                    chip.value.groupId !== HIDDEN_GROUP_ID &&
                    !selecting()
                      ? () => setGroupManageOpen(true)
                      : undefined
                  }
                />
              )}
            </For>
          </div>
        </Show>
      </PageHeader>

      <div
        class="px-[18px] pt-1"
        classList={{
          // 多选时给底部固定操作条让位，避免最后一行书被遮住
          "pb-[calc(116px+env(safe-area-inset-bottom))]": selecting(),
          "pb-[calc(28px+env(safe-area-inset-bottom))]": !selecting(),
        }}
      >
        <Show when={bookMetasReady()} fallback={<LoadingScreen label={t("shelf.loading.library")} />}>
          <Show
            when={visibleItems().length > 0}
            fallback={
              <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
                <LibraryIcon size={56} class="mb-2.5" />
                <p class="text-[15.5px] font-semibold text-text-2">
                  {items().length === 0
                    ? t("shelf.empty.noBooks")
                    : allHiddenOnly()
                      ? t("shelf.empty.allHidden")
                      : activeFilter().kind === "group"
                        ? t("shelf.empty.group")
                        : t("shelf.empty.noMatch")}
                </p>
                <p class="mb-[18px] mt-0.5 text-[12.5px] leading-[1.6]">
                  {items().length === 0
                    ? t("shelf.empty.noBooksHint")
                    : allHiddenOnly()
                      ? t("shelf.empty.allHiddenHint")
                      : activeFilter().kind === "group"
                        ? t("shelf.empty.groupHint")
                        : t("shelf.empty.noMatchHint")}
                </p>
                <ImportButton
                  class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                  ariaLabel={t("shelf.import.title")}
                >
                  {t("shelf.import.title")}
                </ImportButton>
              </div>
            }
          >
            <Show when={selecting()}>
              <p class="mx-0.5 mt-2.5 text-xs text-text-3">
                {t("shelf.select.hint")}
              </p>
              <div class="mt-1">
                <ShelfGrid
                  items={visibleItems()}
                  selectMode
                  selectedIds={selectedIds()}
                  onOpen={openBook}
                  onLongPress={onLongPress}
                  onToggle={toggleSelect}
                />
              </div>
            </Show>
            <Show when={!selecting()}>
              <ShelfGrid
                items={visibleItems()}
                selectMode={false}
                selectedIds={[]}
                onOpen={openBook}
                onLongPress={onLongPress}
                onToggle={toggleSelect}
              />
            </Show>
          </Show>
        </Show>
      </div>

      {/* 多选底部操作条：固定贴住屏幕最底部（期间底部 Tab 由 AppShell 临时隐藏） */}
      <Show when={selecting()}>
        <div class="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[var(--app-column)] animate-sheet-up border-t border-border bg-surface px-[18px] pb-[calc(10px+env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_28px_rgb(0_0_0/0.14)]">
          <Show when={selectedCount() > 0}>
            <div class="flex items-center gap-2.5">
              <button
                class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg px-0.5 py-[11px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2"
                onClick={() => setGroupPickerOpen(true)}
              >
                <FolderIcon size={17} />
                {t("shelf.select.moveToGroup")}
              </button>
              <button
                class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-0.5 py-[11px] text-[13.5px] font-medium transition-colors"
                classList={{
                  "border-transparent bg-danger text-white": confirmDelete(),
                  "border-border bg-bg text-danger": !confirmDelete(),
                }}
                onClick={onRequestDelete}
              >
                <TrashIcon size={17} />
                {confirmDelete()
                  ? t("shelf.select.confirmDelete")
                  : t("common.delete")}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={groupPickerOpen()}>
        <GroupPicker
          value={sharedGroup()}
          onSelect={(targetGroupId) => {
            void moveSelectedToGroup(targetGroupId);
          }}
          onClose={() => setGroupPickerOpen(false)}
        />
      </Show>

      <Show when={groupManageOpen()}>
        <GroupManagerSheet onClose={() => setGroupManageOpen(false)} />
      </Show>
    </div>
  );
}
