/**
 * ① 结构检查（确定性）：格式、字段、类型、范围。
 * 只看报销单本身，不看原文。
 */
import { type CheckIssue, type ReimbursementForm, isCategory } from '../schema.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 判断字符串是否是合法的 YYYY-MM-DD 日期（含真实历法校验）。 */
export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function isPositiveFinite(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

/** 跑 ① 结构检查，返回命中的问题（空数组表示全过）。 */
export function checkStructural(form: ReimbursementForm): readonly CheckIssue[] {
  const issues: CheckIssue[] = []

  if (form.item.trim() === '') {
    issues.push({ layer: 1, field: 'item', code: 'item_empty', message: '费用项目为空' })
  }
  if (!isPositiveFinite(form.amount)) {
    issues.push({ layer: 1, field: 'amount', code: 'amount_not_positive', message: '金额必须是大于 0 的数字' })
  }
  if (!(Number.isFinite(form.tax) && form.tax >= 0)) {
    issues.push({ layer: 1, field: 'tax', code: 'tax_invalid', message: '税额必须是不小于 0 的数字' })
  }
  if (!isValidDate(form.date)) {
    issues.push({ layer: 1, field: 'date', code: 'date_malformed', message: `开票日期不是合法的 YYYY-MM-DD：${form.date}` })
  }
  if (form.invoiceNo.trim() === '') {
    issues.push({ layer: 1, field: 'invoiceNo', code: 'invoice_empty', message: '发票号为空' })
  }
  if (!isCategory(form.category)) {
    issues.push({ layer: 1, field: 'category', code: 'category_unknown', message: `类别不在允许集合内：${form.category}` })
  }

  return issues
}
