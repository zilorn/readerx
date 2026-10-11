import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Drawer } from "./Drawer";
import { OnlineBookSheet } from "./OnlineBookSheet";
import { bookSourceList, ensureBookSourcesLoaded } from "../lib/bookSources";
import { callRemoteSource } from "../lib/backend";
import { mergeSearchResults, toItem, type SourceCandidate } from "../lib/onlineSearch";
import { rememberPicked, type PickedBook } from "../lib/online";
import { currentSourceParallel } from "../lib/store";
import { reportFailure } from "../lib/errorReport";
import { createLogger } from "../lib/logger";
import type { BookMeta } from "../lib/booksTypes";
import { t } from "../lib/i18n";

const log = createLogger("source-switch");

/** 每次挂载重新按原书名搜索；销毁后停止分发并丢弃在飞响应。 */
export function BookSourceSwitch(props: { book: BookMeta; onClose: () => void }) {
  const [candidates, setCandidates] = createSignal<SourceCandidate[]>([]);
  const [busy, setBusy] = createSignal(true);
  const [failed, setFailed] = createSignal(0);
  const [pick, setPick] = createSignal<PickedBook | null>(null);
  let active = true;
  onCleanup(() => { active = false; });
  const title = props.book.title.trim();
  async function search() {
    try {
      await ensureBookSourcesLoaded();
      if (!active) return;
      const sources = bookSourceList().filter((s) => s.enabled && s.capabilities.search);
      let cursor = 0;
      async function worker() {
        while (active && cursor < sources.length) {
          const source = sources[cursor++];
          try {
            const result = await callRemoteSource(source.id, "searchBook", [title]);
            if (!active) return;
            if (!result.ok) throw new Error(result.error || t("discover.sources.actionFailed"));
            const batch = (Array.isArray(result.value) ? result.value : []).map(toItem)
              .filter((item) => item !== null && item.bookName.trim() === title)
              .map((item) => ({ source, item: item! }));
            setCandidates((previous) => mergeSearchResults([], [...previous, ...batch], 1)[0]?.candidates ?? []);
          } catch (error) {
            if (!active) return;
            setFailed((n) => n + 1);
            log.warn("换源搜索失败", `source=${source.id}`, error);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(sources.length, Math.max(1, Math.min(8, currentSourceParallel()))) }, worker));
      if (active) log.info("换源搜索完成", `sources=${sources.length}`, `candidates=${candidates().length}`, `failed=${failed()}`);
    } catch (error) {
      if (active) reportFailure(t("discover.sources.actionFailed"), error);
    } finally {
      if (active) setBusy(false);
    }
  }
  void search();
  return <>
    <Portal>
      <Drawer label={t("discover.sources.choose")} onClose={props.onClose} layer={65} sizeClass="max-h-[80%]">
        <div class="flex items-center justify-between border-b border-border p-4">
          <h2 class="font-semibold">{t("discover.sources.choose")}</h2>
          <button class="p-2 text-text-2" onClick={props.onClose}>{t("common.close")}</button>
        </div>
        <div class="overflow-y-auto p-4">
          <Show when={busy()}><p class="py-2 text-sm text-text-3">{t("common.loading")}</p></Show>
          <Show when={failed() > 0}><p class="py-2 text-xs text-danger">{t("discover.sources.failed", { count: failed() })}</p></Show>
          <Show when={!busy() && !candidates().length}><p class="py-4 text-sm text-text-3">{t("discover.search.noResults")}</p></Show>
          <For each={candidates()}>{(candidate) => <button
            class="flex w-full items-center justify-between border-b border-border py-3 text-left text-sm"
            onClick={() => setPick({ ...candidate, key: rememberPicked(candidate.source, candidate.item) })}>
            <span>{candidate.source.name}</span>
            <Show when={props.book.bookSourceId === candidate.source.id && props.book.bookUrl === candidate.item.bookUrl}>
              <span class="text-xs text-accent">{t("discover.sources.current")}</span>
            </Show>
          </button>}</For>
        </div>
      </Drawer>
    </Portal>
    <OnlineBookSheet pick={pick()} candidates={candidates()} targetBookId={props.book.id} onClose={() => setPick(null)} />
  </>;
}
