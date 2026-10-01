/** 与 Rust sync/identity.rs 共用身份种子；书源和分组编辑后沿用 ID，规则仍按内容派生。 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

function uid(prefix: string, seed: string): string {
  return prefix + bytesToHex(sha256(new TextEncoder().encode(seed))).slice(0, 16);
}
export function stableId(id: string, prefix: string): boolean {
  return id.startsWith(prefix) && /^[0-9a-f]{16}$/i.test(id.slice(prefix.length));
}
export function groupId(name: string): string { return uid("g-", `group\n${name.trim()}`); }
export function sourceGroupId(name: string): string { return uid("sg-", `source_group\n${name.trim()}`); }
export function sourceId(url: string): string { return uid("s-", `source\n${url.trim().replace(/\/+$/, "").toLowerCase()}`); }
export function chapterRuleId(name: string, pattern: string): string { return uid("cr-", `chapter_rule\n${name.trim()}\n${pattern.trim()}`); }
export function replaceRuleId(rule: {scope: string; bookId?: string; find: string; replace: string; regex: boolean}): string {
  return uid("tr-", `text_replace\n${rule.scope}\n${rule.scope === "book" ? rule.bookId ?? "" : ""}\n${rule.regex}\n${rule.find}\n${rule.replace}`);
}
