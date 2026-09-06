/**
 * 书源在线封面展示（BookItem.cover，可选）：
 * - 书源返回封面地址 → 经书源会话（Cookie / UA / 默认头，可带 Referer）下载为
 *   缩略图 data URL 后渲染——防盗链 / 需登录图站的封面也能正常显示；
 * - 无地址 / 下载中 / 下载失败 → 一律回退「书名首字」渐变占位，全程不报错；
 * - 列表行采用「滚进视口附近才下载」的懒加载：一次搜索整页几十上百条结果时，
 *   不会同时对书站发起与结果数等量的图片请求（下载自身还有模块级并发闸）。
 */
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import {
  loadSourceCoverThumb,
  peekSourceCoverThumb,
} from "../lib/sourceCover";

export type SourceCoverVariant = "row" | "sheet";

export interface SourceCoverProps {
  variant: SourceCoverVariant;
  /** 书源 id：决定用哪个书源会话下载封面 */
  sourceId: string;
  /** 书源返回的封面（BookItem.cover；空 / 非法地址 = 无封面） */
  url?: string;
  /** 防盗链 Referer（通常为该书的书页地址 bookUrl） */
  referer?: string;
  /** 书名：占位渐变与首字 */
  title?: string;
  /** 占位渐变基准色相；缺省按书名生成 */
  hue?: number;
}

function hueOf(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

function gradientOf(hue: number): string {
  return `linear-gradient(165deg, hsl(${hue} 58% 52%), hsl(${(hue + 24) % 360} 62% 34%))`;
}

const BOX_CLASS: Record<SourceCoverVariant, string> = {
  // 搜索结果/发现列表行的封面缩略图
  row: "relative grid h-[52px] w-[40px] flex-none place-items-center overflow-hidden rounded-[8px] text-[20px] font-bold text-white shadow-inner",
  // 在线书详情抽屉的大封面
  sheet:
    "relative grid h-[132px] w-[96px] flex-none place-items-center overflow-hidden rounded-[10px] text-[40px] font-bold text-white shadow-lg shadow-black/15",
};

export function SourceCover(props: SourceCoverProps) {
  const [mode, setMode] = createSignal<"letter" | "image">("letter");
  const [thumb, setThumb] = createSignal("");
  const [imgFailed, setImgFailed] = createSignal(false);
  /** 懒加载：滚进视口附近（含 160px 预读）才真正发起封面下载 */
  const [visible, setVisible] = createSignal(false);
  let observer: IntersectionObserver | null = null;
  let run = 0;

  function attachBox(el: HTMLSpanElement | undefined) {
    if (!el || observer) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer?.disconnect();
          observer = null;
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(el);
  }
  onCleanup(() => {
    observer?.disconnect();
    observer = null;
  });

  createEffect(() => {
    const url = (props.url ?? "").trim();
    const sourceId = props.sourceId;
    const ref = (props.referer ?? "").trim();
    // URL / 书源切换后先回到占位，避免旧封面短暂残留
    setImgFailed(false);
    setThumb("");
    const current = ++run;
    // 会话里已加载过的封面（含数据直给的封面）无需网络，直接展示
    const cached = url ? peekSourceCoverThumb(sourceId, url) : null;
    if (cached) {
      setThumb(cached);
      setMode("image");
      return;
    }
    if (!url || !visible()) {
      setMode("letter");
      return;
    }
    setMode("letter");
    void loadSourceCoverThumb(sourceId, url, ref || null).then((data) => {
      if (current !== run) return; // 已切换到其它封面，丢弃过期结果
      if (data) {
        setThumb(data);
        setMode("image");
      }
      // 拉取失败保持占位
    });
  });

  const showImage = () => mode() === "image" && thumb() !== "" && !imgFailed();
  const hue = () => props.hue ?? hueOf(props.title ?? "");
  const letter = () => (props.title ?? "").trim().charAt(0);

  return (
    <span
      ref={(el) => attachBox(el)}
      class={BOX_CLASS[props.variant]}
      style={{ background: gradientOf(hue()) }}
    >
      <Show when={showImage()}>
        <img
          src={thumb()}
          alt=""
          draggable={false}
          class="absolute inset-0 h-full w-full object-cover"
          onError={() => setImgFailed(true)}
        />
      </Show>
      <Show when={!showImage()}>
        <span class="select-none leading-none">{letter()}</span>
      </Show>
    </span>
  );
}
