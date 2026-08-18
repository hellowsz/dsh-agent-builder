/**
 * 报销单的数据结构与门禁结果类型。
 * 所有类型只读——判据只读不改产出，符合不可变原则。
 */

/** 允许的费用类别集合。 */
export const CATEGORIES = ['餐饮', '交通', '住宿', '办公', '其他'] as const
export type Category = (typeof CATEGORIES)[number]

/** 候选报销单：agent 从原始文字抽取后填出来的结构化结果。 */
export interface ReimbursementForm {
  /** 费用项目 */
  readonly item: string
  /** 金额（含税） */
  readonly amount: number
  /** 税额 */
  readonly tax: number
  /** 开票日期，YYYY-MM-DD */
  readonly date: string
  /** 发票号 */
  readonly invoiceNo: string
  /** 类别 */
  readonly category: string
  /** 备注 */
  readonly note: string
}

/** 门禁检查命中的一条问题。 */
export interface CheckIssue {
  /** 命中的门禁层：1 结构 / 2 规则 / 3 对照 */
  readonly layer: 1 | 2 | 3
  /** 相关字段 */
  readonly field: string
  /** 机器可读的问题码 */
  readonly code: string
  /** 给人看的说明，也用于失败时喂回 agent */
  readonly message: string
}

/** 一次门禁裁决的结果。 */
export interface GateVerdict {
  /** 是否全部通过 */
  readonly passed: boolean
  /** 所有命中的问题（通过时为空数组） */
  readonly issues: readonly CheckIssue[]
}

/** 判断一个值是否是有效的类别。 */
export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value)
}
