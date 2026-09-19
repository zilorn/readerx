/**
 * “关于 → 开源库声明”弹层：读取随应用打包的 THIRD-PARTY-NOTICES.md 全文
 * （第三方开源库、各自许可与在 ReaderX 中的用途）。
 */
import { readThirdPartyNotices } from "../lib/backend";
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
      title="开源库声明"
      subtitle="ReaderX 使用的第三方开源库"
      icon={<PackageIcon size={18} />}
      closeLabel="关闭开源库声明"
      load={readThirdPartyNotices}
      errorText="无法读取开源库声明"
    />
  );
}
