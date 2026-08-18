/**
 * 文本取数工具：③ 对照检查用。
 * 数字按分词提取（防止把长发票号的子串误当金额），日期支持中文与 ISO 写法。
 */

/** 从文本里抽出所有数字（去千分位）。 */
export function extractNumbers(text: string): readonly number[] {
  const matches = text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []
  return matches
    .map((m) => Number.parseFloat(m.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n))
}

/** 某个数值是否在文本里出现过（允许极小浮点误差）。 */
export function numberAppears(value: number, text: string): boolean {
  return extractNumbers(text).some((n) => Math.abs(n - value) < 0.005)
}

/** 从文本抽出所有日期，规范化为 YYYY-MM-DD。支持「2026年8月12日」与「2026-08-12」。 */
export function extractDates(text: string): readonly string[] {
  const out: string[] = []
  const pad = (s: string) => s.padStart(2, '0')

  const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g
  for (const m of text.matchAll(cn)) out.push(`${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`)

  const iso = /(\d{4})-(\d{2})-(\d{2})/g
  for (const m of text.matchAll(iso)) out.push(`${m[1]}-${m[2]}-${m[3]}`)

  return out
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 是否是合法 YYYY-MM-DD（含真实历法校验）。 */
export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
