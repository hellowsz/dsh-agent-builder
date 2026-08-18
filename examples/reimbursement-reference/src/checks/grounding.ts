/**
 * ③ 对照检查（防编造）——最值钱的一层。
 * 报销单里的金额、税额、发票号、日期，必须能在原始输入文字里找到依据；
 * 找不到就判为疑似编造/改数，拦下。
 */
import { type CheckIssue, type ReimbursementForm } from '../schema.js'

/** 从文本里抽出所有数字（去掉千分位），用于金额/税额对照。 */
export function extractNumbers(text: string): readonly number[] {
  const matches = text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []
  return matches
    .map((m) => Number.parseFloat(m.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n))
}

/** 某个金额是否在文本里出现过（允许极小的浮点误差）。 */
export function numberAppears(value: number, text: string): boolean {
  return extractNumbers(text).some((n) => Math.abs(n - value) < 0.005)
}

/** 从文本里抽出所有日期，规范化成 YYYY-MM-DD。支持「2026年8月12日」与「2026-08-12」。 */
export function extractDates(text: string): readonly string[] {
  const out: string[] = []
  const pad = (s: string) => s.padStart(2, '0')

  const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g
  for (const m of text.matchAll(cn)) out.push(`${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`)

  const iso = /(\d{4})-(\d{2})-(\d{2})/g
  for (const m of text.matchAll(iso)) out.push(`${m[1]}-${m[2]}-${m[3]}`)

  return out
}

/** 跑 ③ 对照检查。source 是用户贴入的原始文字。 */
export function checkGrounding(form: ReimbursementForm, source: string): readonly CheckIssue[] {
  const issues: CheckIssue[] = []

  if (Number.isFinite(form.amount) && form.amount > 0 && !numberAppears(form.amount, source)) {
    issues.push({ layer: 3, field: 'amount', code: 'amount_not_grounded', message: `金额（${form.amount}）在原文里找不到依据，疑似改数或编造` })
  }
  if (Number.isFinite(form.tax) && form.tax > 0 && !numberAppears(form.tax, source)) {
    issues.push({ layer: 3, field: 'tax', code: 'tax_not_grounded', message: `税额（${form.tax}）在原文里找不到依据` })
  }
  if (form.invoiceNo.trim() !== '' && !source.includes(form.invoiceNo.trim())) {
    issues.push({ layer: 3, field: 'invoiceNo', code: 'invoice_not_grounded', message: `发票号（${form.invoiceNo}）在原文里找不到，疑似编造` })
  }
  if (form.date.trim() !== '' && !extractDates(source).includes(form.date)) {
    issues.push({ layer: 3, field: 'date', code: 'date_not_grounded', message: `开票日期（${form.date}）在原文里找不到依据` })
  }

  return issues
}
