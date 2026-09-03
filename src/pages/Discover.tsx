import { PageHeader } from "../components/PageHeader";
import { CompassIcon } from "../components/icons";

export default function DiscoverPage() {
  return (
    <div class="page">
      <PageHeader title="发现" />
      <div class="px-[18px] pb-[calc(28px+env(safe-area-inset-bottom))] pt-1">
        <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
          <CompassIcon size={52} class="mb-2.5" />
          <p class="text-[15.5px] font-semibold text-text-2">这里暂时还是空的</p>
          <p class="mt-0.5 text-[12.5px] leading-[1.6]">
            等接入书源后，就能在这里浏览和发现书籍了
          </p>
        </div>
      </div>
    </div>
  );
}
