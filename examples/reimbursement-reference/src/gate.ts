/**
 * 报销门禁：把 ①结构 ②规则 ③对照 三层确定性检查合起来跑，出一个裁决。
 * ④ AI 评审由独立评审 agent 承担，不在这里（这里只做确定性判据）。
 *
 * 三层都跑、汇总所有问题，而不是命中即停——这样失败时能把完整原因喂回 agent。
 */
import { type GateVerdict, type ReimbursementForm } from './schema.js'
import { checkStructural } from './checks/structural.js'
import { checkRules } from './checks/rules.js'
import { checkGrounding } from './checks/grounding.js'

export interface GateInput {
  /** 候选报销单 */
  readonly form: ReimbursementForm
  /** 用户贴入的原始文字 */
  readonly source: string
  /** 今天，YYYY-MM-DD，用于 ② 的日期校验 */
  readonly today: string
}

/** 跑一遍确定性门禁，返回是否通过与所有命中的问题。 */
export function runGate(input: GateInput): GateVerdict {
  const issues = [
    ...checkStructural(input.form),
    ...checkRules(input.form, input.today),
    ...checkGrounding(input.form, input.source),
  ]
  return { passed: issues.length === 0, issues }
}
