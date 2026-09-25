/**
 * 简体中文词典（源语言）。
 *
 * 这里只做汇总，文案按业务模块分别维护在 `zh-CN/` 下 —— 一个模块一个文件，
 * 避免所有文案堆成一个大文件。新增 / 修改文案改对应模块文件即可。
 *
 * `MessageKey` 是全部 key 的联合类型：`t()` 的入参按它约束，
 * 英文词典（`en.ts`）按它检查完整性，写错 key / 漏翻译都会在编译期报错。
 */
import { common } from "./zh-CN/common";
import { shell } from "./zh-CN/shell";
import { settings } from "./zh-CN/settings";
import { shelf } from "./zh-CN/shelf";
import { book } from "./zh-CN/book";
import { reader } from "./zh-CN/reader";
import { readerChrome } from "./zh-CN/readerChrome";
import { discover } from "./zh-CN/discover";
import { sources } from "./zh-CN/sources";
import { sourceEditor } from "./zh-CN/sourceEditor";
import { chapterRules } from "./zh-CN/chapterRules";
import { sourceGroups } from "./zh-CN/sourceGroups";
import { tts } from "./zh-CN/tts";
import { webdav } from "./zh-CN/webdav";
import { library } from "./zh-CN/library";
import { misc } from "./zh-CN/misc";

export const zhCN = {
  ...common,
  ...shell,
  ...settings,
  ...shelf,
  ...book,
  ...reader,
  ...readerChrome,
  ...discover,
  ...sources,
  ...sourceEditor,
  ...chapterRules,
  ...sourceGroups,
  ...tts,
  ...webdav,
  ...library,
  ...misc,
};

/** 全部文案 key */
export type MessageKey = keyof typeof zhCN;
