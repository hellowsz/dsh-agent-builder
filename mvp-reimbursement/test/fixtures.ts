/**
 * 测试样例：一个真实报销文字 + 从它正确抽取的报销单（好样例），
 * 以及一组"故意弄坏"的报销单（坏样例），用来验证门禁能挡坏放好。
 */
import { type ReimbursementForm } from '../src/schema.js'

/** 用户贴入的原始文字。 */
export const SOURCE = [
  '上海某餐饮 2026年8月12日 电子发票 号码 24317000000123456789',
  '金额 428.00 元 税率 6% 税额 24.23 餐饮服务',
].join('\n')

/** 固定"今天"，让 ② 的日期校验可重复。 */
export const TODAY = '2026-08-18'

/** 好样例：正确抽取，应当全部通过。 */
export const GOOD_FORM: ReimbursementForm = {
  item: '餐饮服务',
  amount: 428.0,
  tax: 24.23,
  date: '2026-08-12',
  invoiceNo: '24317000000123456789',
  category: '餐饮',
  note: '上海某餐饮',
}

/** 一个坏样例连同它应命中的问题码，方便断言"挡住了正确的那条"。 */
export interface BadCase {
  readonly name: string
  readonly form: ReimbursementForm
  readonly expectCode: string
}

export const BAD_CASES: readonly BadCase[] = [
  {
    name: '改金额：428 被写成 482',
    form: { ...GOOD_FORM, amount: 482.0 },
    expectCode: 'amount_not_grounded',
  },
  {
    name: '编发票号：原文里没有的号码',
    form: { ...GOOD_FORM, invoiceNo: '99999999999999999999' },
    expectCode: 'invoice_not_grounded',
  },
  {
    name: '未来日期：晚于今天',
    form: { ...GOOD_FORM, date: '2027-01-01' },
    expectCode: 'date_in_future',
  },
  {
    name: '非法类别：不在允许集合',
    form: { ...GOOD_FORM, category: '娱乐' },
    expectCode: 'category_unknown',
  },
  {
    name: '税额大于金额',
    form: { ...GOOD_FORM, tax: 500.0 },
    expectCode: 'tax_gt_amount',
  },
  {
    name: '金额非正数',
    form: { ...GOOD_FORM, amount: 0 },
    expectCode: 'amount_not_positive',
  },
]
