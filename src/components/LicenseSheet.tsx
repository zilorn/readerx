/**
 * “关于 → 开源许可”弹层：读取随应用打包的 LICENSE 全文。
 */
import { readLicenseText } from "../lib/backend";
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
      subtitle="ReaderX 开源许可"
      icon={<FileTextIcon size={18} />}
      closeLabel="关闭开源许可"
      load={readLicenseText}
      errorText="无法读取许可文本"
    />
  );
}
