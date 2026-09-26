/**
 * “关于 → 开源许可”弹层：读取随应用打包的 LICENSE 全文。
 */
import { readLicenseText } from "../lib/backend";
import { t } from "../lib/i18n";
import { FileTextIcon } from "./icons";
import { TextDocumentSheet } from "./TextDocumentSheet";

/** 随包 LICENSE 的许可名：设置项说明与弹层标题共用一份；许可名中英一致，不进词典 */
export const LICENSE_NAME = "GNU General Public License v3.0";

interface LicenseSheetProps {
  open: boolean;
  onClose: () => void;
}

export function LicenseSheet(props: LicenseSheetProps) {
  return (
    <TextDocumentSheet
      open={props.open}
      onClose={props.onClose}
      title={LICENSE_NAME}
      subtitle={t("settings.license.subtitle")}
      icon={<FileTextIcon size={18} />}
      closeLabel={t("settings.license.close")}
      load={readLicenseText}
      errorText={t("settings.license.error")}
    />
  );
}
