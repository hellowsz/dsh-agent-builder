/**
 * ② 规则检查（确定性）：业务硬约束。
 * `today` 由外部传入（YYYY-MM-DD），让检查可重复、可测试，不依赖真实时钟。
 */
import { type CheckIssue, type ReimbursementForm } from '../schema.js'
import { isValidDate } from './structural.js'

/** 税额相对含税金额的合理上限（含税价里税的占比很难超过此值），用作 sanity 边界。 */
const MAX_TAX_RATIO = 0.2

/** 跑 ② 规则检查。跳过那些已被 ① 判为非法的字段，避免重复报错。 */
export function checkRules(form: ReimbursementForm, today: string): readonly CheckIssue[] {
  const issues: CheckIssue[] = []

  const amountOk = Number.isFinite(form.amount) && form.amount > 0
  const taxOk = Number.isFinite(form.tax) && form.tax >= 0

  if (amountOk && taxOk && form.tax > form.amount) {
    issues.push({ layer: 2, field: 'tax', code: 'tax_gt_amount', message: `税额（${form.tax}）不应大于含税金额（${form.amount}）` })
  }
  if (amountOk && taxOk && form.tax <= form.amount && form.tax > form.amount * MAX_TAX_RATIO) {
    issues.push({ layer: 2, field: 'tax', code: 'tax_ratio_implausible', message: `税额占比过高（税额 ${form.tax} / 金额 ${form.amount}），疑似抽取错误` })
  }
  if (isValidDate(form.date) && isValidDate(today) && form.date > today) {
    issues.push({ layer: 2, field: 'date', code: 'date_in_future', message: `开票日期（${form.date}）晚于今天（${today}）` })
  }

  return issues
}
