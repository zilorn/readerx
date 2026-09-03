import { CompassIcon } from "../components/icons";
import { PageHeader } from "../components/PageHeader";

/**
 * 发现页：保留为书源浏览入口，当前暂无书源内容，保持空态。
 */
export default function DiscoverPage() {
  return (
    <div class="page">
      <PageHeader title="发现" />
      <div class="flex flex-col items-center gap-1 px-6 py-16 text-center text-text-3">
        <CompassIcon size={52} class="mb-2.5" />
        <p class="text-[15.5px] font-semibold text-text-2">暂无书源</p>
        <p class="mt-0.5 text-[12.5px] leading-[1.6]">
          书源接入功能开发中，敬请期待
        </p>
      </div>
    </div>
  );
}
