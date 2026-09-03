/**
 * 模糊搜索匹配工具（书架内搜索用，无外部依赖）：
 * - 大小写不敏感，忽略空白差异（书名 / 文件名中的空格不影响命中）；
 * - 支持“逐字命中”：query 的每个字符只需按顺序出现在文本里，不必连续；
 * - 命中返回质量分（越大越靠前），未命中返回 -1。
 */

/** 归一化：小写 + 去掉全部空白，让连续命中判断不受空格干扰 */
export function normalizeSearchText(value: string): string {
  return (value ?? "").toLocaleLowerCase().replace(/\s+/g, "");
}

/**
 * 模糊匹配打分：
 * - 连续子串：1000 - 起始位置（越靠开头分越高）；
 * - 逐字有序命中：800 - 最后命中位置（越早收尾分越高）；
 * - 无法按序命中返回 -1。
 */
export function fuzzyScore(rawQuery: string, rawText: string): number {
  const q = normalizeSearchText(rawQuery);
  const t = normalizeSearchText(rawText);
  if (!q || q.length > t.length) return -1;

  const start = t.indexOf(q);
  if (start >= 0) return 1000 - start;

  let last = -1;
  for (const ch of q) {
    const hit = t.indexOf(ch, last + 1);
    if (hit < 0) return -1;
    last = hit;
  }
  return 800 - last;
}
