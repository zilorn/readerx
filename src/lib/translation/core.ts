import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { LocalBookChapter } from "../booksTypes";
import type { TranslationSettings, GlossaryTerm } from "./types";
export const fingerprint = (value: unknown): string =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
export function translationKey(
  text: string,
  settings: TranslationSettings,
  terms: GlossaryTerm[],
): string {
  // 密钥不进入缓存键明文或日志；账户切换也隔离缓存。
  return fingerprint([
    "translation/1",
    text,
    settings.target,
    settings.provider,
    settings.protocol,
    settings.baseUrl,
    settings.model,
    settings.effort,
    fingerprint(settings.apiKey),
    // Rust JSON 对象字段会排序，改用固定字段顺序；术语清单排列也不改变语义。
    terms
      .map((term) => [term.source, term.target, term.note])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  ]);
}
export function chapterText(chapter: LocalBookChapter): string[] {
  return chapter.blocks?.length
    ? chapter.blocks.filter((b) => b.kind === "p").map((b) => b.text)
    : chapter.paragraphs;
}
/** 有界分层采样，跨首/中/末章；不展开整本书或把全文交给 AI。 */
export function representativeSamples(chapters: LocalBookChapter[]): string[] {
  const samples: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(chapters.length, 12); i++) {
    const ci = Math.floor(
      (i * Math.max(0, chapters.length - 1)) /
        Math.max(1, Math.min(chapters.length, 12) - 1),
    );
    const paragraphs = chapterText(chapters[ci]);
    // 优先完整段落，每章取头/中/尾，每个位置 ≤500 UTF-16 字符。
    const sample = [
      0,
      Math.floor(paragraphs.length / 2),
      Math.max(0, paragraphs.length - 1),
    ]
      .map((index) => (paragraphs[index] ?? "").slice(0, 500))
      .filter(Boolean)
      .join("\n");
    if (sample.trim() && !seen.has(sample)) {
      samples.push(sample);
      seen.add(sample);
    }
  }
  return samples;
}
export function foreignBook(chapters: LocalBookChapter[]): boolean {
  const sample = representativeSamples(chapters).join("\n");
  const letters = sample.match(/\p{L}/gu) ?? [];
  if (letters.length < 80) return false;
  const han = sample.match(/\p{Script=Han}/gu)?.length ?? 0;
  return (
    han / letters.length < 0.5 ||
    /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample)
  );
}
/** 保守的目标语言判定；不确定的文本交给服务自动检测。 */
export function alreadyTarget(text: string, target: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return true;
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  const hangul = text.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  if (target.startsWith("zh")) return han / letters > 0.6 && !kana && !hangul;
  if (target === "ja")
    return (
      kana &&
      (han +
        (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ??
          0)) /
        letters >
        0.6
    );
  if (target === "ko") return hangul / letters > 0.6;
  // 拉丁字母语种大量共用短词（如德语 was）；没有可靠语种检测时交给服务。
  return false;
}
export function normalizeTerms(input: unknown): GlossaryTerm[] {
  if (!Array.isArray(input)) throw new Error("Invalid glossary");
  const seen = new Set<string>();
  return input.slice(0, 200).flatMap((term) => {
    if (
      !term ||
      typeof term.source !== "string" ||
      typeof term.target !== "string"
    )
      return [];
    const source = term.source.trim().slice(0, 100),
      target = term.target.trim().slice(0, 100);
    if (!source || !target || seen.has(source)) return [];
    seen.add(source);
    return [
      {
        source,
        target,
        note: Array.from(typeof term.note === "string" ? term.note.trim() : "")
          .slice(0, 29)
          .join(""),
      },
    ];
  });
}
export function paragraphBatches<T>(items: T[], size = 15): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
