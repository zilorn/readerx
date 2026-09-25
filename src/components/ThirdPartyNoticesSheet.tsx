/**
 * “关于 → 开源库声明”弹层：读取随应用打包的 THIRD-PARTY-NOTICES.md 全文
 * （第三方开源库、各自许可与在 ReaderX 中的用途）。
 */
import { readThirdPartyNotices } from "../lib/backend";
import { t } from "../lib/i18n";
import { PackageIcon } from "./icons";
import { TextDocumentSheet } from "./TextDocumentSheet";

interface ThirdPartyNoticesSheetProps {
  open: boolean;
  onClose: () => void;
}

export function ThirdPartyNoticesSheet(props: ThirdPartyNoticesSheetProps) {
  return (
    <TextDocumentSheet
      open={props.open}
      onClose={props.onClose}
      title={t("settings.notices.title")}
      subtitle={t("settings.notices.subtitle")}
      icon={<PackageIcon size={18} />}
      closeLabel={t("settings.notices.close")}
      load={readThirdPartyNotices}
      errorText={t("settings.notices.error")}
    />
  );
}
