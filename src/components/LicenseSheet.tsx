/**
 * “关于 → 开源许可”弹层：读取随应用打包的 LICENSE 全文。
 */
import { readLicenseText } from "../lib/backend";
import { t } from "../lib/i18n";
import { FileTextIcon } from "./icons";
import { TextDocumentSheet } from "./TextDocumentSheet";

interface LicenseSheetProps {
  open: boolean;
  onClose: () => void;
}

export function LicenseSheet(props: LicenseSheetProps) {
  return (
    <TextDocumentSheet
      open={props.open}
      onClose={props.onClose}
      title="MIT License"
      subtitle={t("settings.license.subtitle")}
      icon={<FileTextIcon size={18} />}
      closeLabel={t("settings.license.close")}
      load={readLicenseText}
      errorText={t("settings.license.error")}
    />
  );
}
