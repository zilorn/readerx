/**
 * 构建期生成简繁转换词典资源（gzip），产物为 `src/generated/han-dict-<方向>.bin`。
 *
 * 为什么要单独打包词典：
 * opencc-js 把词典作为 JS 字符串字面量发布，简→繁那一份打包出来是 1.1 MB 的 JS chunk，
 * WebView 得先下载再解析这么大的模块。词典是纯数据，gzip 后仅约 450 KB，而
 * 「取回 → 解压 → 建树」比解析 1.1 MB JS 更省，因此改为构建期压缩成二进制资源、
 * 运行时按方向（简→繁 / 繁→简）按需取用 —— 没开启简繁转换的用户完全不会碰到它。
 *
 * 词典内容依旧来自 opencc-js（OpenCC 的纯 JS 实现，MIT / Apache-2.0）：
 * 每次构建都从 node_modules 里当前版本的词典文件重新读取，不会与依赖版本漂移。
 *
 * 资源格式（运行时解析见 src/lib/hanDict.ts）：
 *   第 1 行：格式版本（HAN_DICT_FORMAT）
 *   第 2 行：分区名列表（逗号分隔，顺序即后面各行的顺序）
 *   第 3 行起：各分区词典正文（opencc-js 的 `原文 替换|原文 替换` 形式）
 *
 * 分区划分照抄 opencc-js 的 preset 配置，保证转换结果与 `opencc-js/cn2t`、`opencc-js/t2cn` 完全一致：
 *   s2t = cn2t：normalizationChain [CJK] + conversionChain [[STPhrases, STPhrases_GeneratedFromRegionalPhrases, STCharacters]]
 *   t2s = t2cn：normalizationChain [CJK] + segmentation [TSPhrases] + conversionChain [[TSPhrases, TSCharacters]]
 *
 * 用法：`node scripts/han-dict.mjs`（幂等；词典未变时不写盘）。
 * vite.config.ts 在 dev / build 启动时自动调用，一般不需要手动执行。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/** 资源格式版本：改动资源布局时递增，并与 src/lib/hanDict.ts 的 FORMAT 保持一致 */
export const HAN_DICT_FORMAT = "readerx-han-dict/1";

/** 每个方向用到的词典分区，顺序 = 运行时解包顺序（改动必须同步 src/lib/hanDict.ts） */
export const HAN_DICT_SECTIONS = {
  s2t: [
    "CJK_Compatibility_Ideographs",
    "STPhrases",
    "STPhrases_GeneratedFromRegionalPhrases",
    "STCharacters",
  ],
  t2s: ["CJK_Compatibility_Ideographs", "TSPhrases", "TSCharacters"],
};

const DICT_DIR = new URL("../node_modules/opencc-js/dist/esm-lib/dict/", import.meta.url);
const OUT_DIR = new URL("../src/generated/", import.meta.url);

/** 词典文件路径 */
function dictFile(name) {
  return new URL(`${name}.js`, DICT_DIR);
}

/** 读取一个词典分区的正文（opencc-js 的词典模块是 `export default "<正文>"`） */
function readDict(name) {
  const file = dictFile(name);
  const source = readFileSync(file, "utf8");
  const marker = "export default";
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`opencc-js 词典格式不符合预期（${name}）：找不到 ${marker}`);
  }
  const literal = source
    .slice(start + marker.length)
    .trim()
    .replace(/;$/, "");
  let value;
  try {
    value = JSON.parse(literal);
  } catch (error) {
    throw new Error(`opencc-js 词典格式不符合预期（${name}）：${String(error)}`);
  }
  if (typeof value !== "string") {
    throw new Error(`opencc-js 词典格式不符合预期（${name}）：期望字符串，实际是 ${typeof value}`);
  }
  return value;
}

/** 拼出某个方向的词典正文（带格式头） */
function buildPayload(direction) {
  const sections = HAN_DICT_SECTIONS[direction];
  if (!sections) throw new Error(`未知的简繁转换方向：${direction}`);
  const lines = [HAN_DICT_FORMAT, sections.join(",")];
  for (const name of sections) lines.push(readDict(name));
  return lines.join("\n");
}

/** 产物是否比所有输入都新（词典随依赖更新，未变时不必重新压缩） */
function isFresh(outFile, inputs) {
  if (!existsSync(outFile)) return false;
  const out = statSync(outFile).mtimeMs;
  return inputs.every((file) => statSync(file).mtimeMs <= out);
}

/** 生成单个方向的资源；已是最新则跳过 */
export function writeHanDictAsset(direction, { log = false } = {}) {
  const sections = HAN_DICT_SECTIONS[direction];
  if (!sections) throw new Error(`未知的简繁转换方向：${direction}`);

  const outFile = new URL(`han-dict-${direction}.bin`, OUT_DIR);
  if (isFresh(outFile, sections.map(dictFile))) return;

  const payload = Buffer.from(buildPayload(direction), "utf8");
  const gzipped = gzipSync(payload, { level: 9 });
  mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });
  writeFileSync(outFile, gzipped);
  if (log) {
    console.log(
      `[han-dict] ${direction}: ${payload.length} B → ${gzipped.length} B（gzip）`,
    );
  }
}

/** 生成全部方向的资源（dev / build 启动时调用，幂等） */
export function ensureHanDictAssets({ log = false } = {}) {
  for (const direction of Object.keys(HAN_DICT_SECTIONS)) {
    writeHanDictAsset(direction, { log });
  }
}

// 直接执行本文件时打印体积，便于核对
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureHanDictAssets({ log: true });
}
