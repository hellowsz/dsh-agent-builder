/** 测试规格：报销单据整理（与 MVP 对齐稿一致）。 */
import { type TaskSpec } from '../src/spec.js'

export const REIMBURSEMENT_SPEC: TaskSpec = {
  name: 'reimbursement',
  title: '报销单据整理助手',
  description: '把用户贴入的发票/账单文字整理成一张结构化报销单',
  fields: [
    { name: 'item', label: '费用项目', kind: 'text' },
    { name: 'amount', label: '金额（含税）', kind: 'number' },
    { name: 'tax', label: '税额', kind: 'number' },
    { name: 'date', label: '开票日期', kind: 'date' },
    { name: 'invoice-no', label: '发票号', kind: 'text' },
    { name: 'category', label: '类别', kind: 'enum', values: ['餐饮', '交通', '住宿', '办公', '其他'] },
    { name: 'note', label: '备注', kind: 'text', optional: true, grounded: false },
  ],
  rules: [
    { id: 'tax_gt_amount', type: 'compare', left: 'tax', op: '<=', right: 'amount', message: '税额不应大于含税金额' },
    { id: 'date_in_future', type: 'not-future', field: 'date', message: '开票日期晚于今天' },
  ],
  aiReview: [
    { id: 'category_sensible', criteria: '类别归类与费用项目、商户信息是否相符' },
  ],
}

export const GOOD_SOURCE = '上海某餐饮 2026年8月12日 电子发票 号码 24317000000123456789 金额 428.00 元 税额 24.23 餐饮服务'

/** 正确抽取的 JSON 答复（工作 agent 替身的"好行为"）。 */
export const GOOD_ANSWER = [
  '整理好了：',
  '```json',
  JSON.stringify({
    item: '餐饮服务',
    amount: 428.0,
    tax: 24.23,
    date: '2026-08-12',
    'invoice-no': '24317000000123456789',
    category: '餐饮',
    note: '上海某餐饮',
  }),
  '```',
].join('\n')

/** 改了金额的答复（坏行为：428→482）。 */
export const TAMPERED_ANSWER = GOOD_ANSWER.replace('428', '482')
