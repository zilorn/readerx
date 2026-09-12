/**
 * 简繁转换词典的运行时装载：取回构建期压好的 gzip 资源 → 解压 → 用 opencc-js 建树。
 *
 * 词典资源由 `scripts/han-dict.mjs` 在 dev / build 启动时生成（见该文件的格式说明），
 * 这里只负责按方向取用：开了「简→繁」就只取 s2t 那一份，反之亦然。
 *
 * 转换结果与 opencc-js 的 preset 完全一致（分区与链条照抄 preset 配置）：
 * - s2t：先做兼容汉字归一，再做 [短语词典, 地区短语词典, 单字词典] 三段转换；
 * - t2s：先归一，再按短语词典切分，最后做 [短语词典, 单字词典] 转换。
 *
 * 简→繁一份约 450 KB（gzip）、繁→简约 23 KB，都只在用户真正开启该方向时才下载。
 */
import { ConverterFactory, Trie } from "opencc-js/core";
import s2tAsset from "../generated/han-dict-s2t.bin?url";
import t2sAsset from "../generated/han-dict-t2s.bin?url";

/** 转换方向：s2t = 简 → 繁；t2s = 繁 → 简 */
export type HanDirection = "s2t" | "t2s";

/** 转换函数：只换字形，不换含义；未收录的字符原样保留 */
export type HanConverter = (text: string) => string;

/** 资源格式版本，必须与 scripts/han-dict.mjs 的 HAN_DICT_FORMAT 一致 */
const FORMAT = "readerx-han-dict/1";

/** 分区顺序必须与 scripts/han-dict.mjs 的 HAN_DICT_SECTIONS 一致 */
const SECTIONS: Record<HanDirection, readonly string[]> = {
  s2t: [
    "CJK_Compatibility_Ideographs",
    "STPhrases",
    "STPhrases_GeneratedFromRegionalPhrases",
    "STCharacters",
  ],
  t2s: ["CJK_Compatibility_Ideographs", "TSPhrases", "TSCharacters"],
};

const ASSETS: Record<HanDirection, string> = { s2t: s2tAsset, t2s: t2sAsset };

/** 取回词典资源并解压成文本 */
async function fetchPayload(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`词典资源请求失败：HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  // 优先用内核自带的 gzip 解压流；老内核没有时退回纯 JS 解压（fflate，仅在需要时才载入）
  if (typeof DecompressionStream === "function") {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).text();
    } catch {
      // 落到下面的 fflate 分支
    }
  }
  const { gunzipSync, strFromU8 } = await import("fflate");
  return strFromU8(gunzipSync(new Uint8Array(bytes)));
}

/** 校验格式头并拆出各分区正文，按分区名成表 */
function unpackSections(direction: HanDirection, payload: string): Record<string, string> {
  const lines = payload.split("\n");
  const expected = SECTIONS[direction];
  const [format, names] = lines;
  if (format !== FORMAT || names !== expected.join(",") || lines.length !== expected.length + 2) {
    throw new Error("词典资源与当前版本不匹配（请重新构建）");
  }
  const sections: Record<string, string> = {};
  expected.forEach((name, index) => {
    sections[name] = lines[index + 2];
  });
  return sections;
}

/** 用词典正文装出该方向的转换函数（链条与 opencc-js preset 保持一致） */
function buildConverter(direction: HanDirection, sections: Record<string, string>): HanConverter {
  const normalize = ConverterFactory([sections.CJK_Compatibility_Ideographs]);
  if (direction === "s2t") {
    const convert = ConverterFactory([
      sections.STPhrases,
      sections.STPhrases_GeneratedFromRegionalPhrases,
      sections.STCharacters,
    ]);
    return (text) => convert(normalize(text));
  }
  // 繁 → 简先按短语词典把长词切开，避免单字词典把词内字拆错
  const segmentation = new Trie();
  segmentation.loadDictGroup([sections.TSPhrases]);
  const convert = ConverterFactory([sections.TSPhrases, sections.TSCharacters]);
  return (text) => segmentation.segment(text).map((segment) => convert(segment)).join("");
}

/** 装载某个方向的转换函数（失败时抛出，由调用方提示用户） */
export async function loadHanConverter(direction: HanDirection): Promise<HanConverter> {
  const payload = await fetchPayload(ASSETS[direction]);
  return buildConverter(direction, unpackSections(direction, payload));
}
