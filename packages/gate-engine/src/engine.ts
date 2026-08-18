/**
 * 门禁执行器：定义 + 输入 → 裁决。
 * 全部检查都跑、汇总所有问题（不命中即停），失败时能把完整原因喂回 agent。
 */
import { type CheckDef, type CheckIssue, type GateDefinition, type GateInput, type GateVerdict } from './types.js'
import { evaluateCheck } from './checks.js'

/** 一条检查引用到的字段（rule 的 left/right 也算）。 */
function fieldsOf(def: CheckDef): readonly string[] {
  return def.type === 'compare' ? [def.left, def.right] : [def.field]
}

const STRUCTURAL_TYPES = new Set<CheckDef['type']>(['required', 'number', 'date', 'enum'])

/**
 * 跑一遍确定性门禁。④ AI 评审条目原样带出，交独立评审 agent 执行。
 *
 * 跳过语义（避免对同一处毛病重复/递进报错）：
 * - 先跑 ① 结构检查；某字段结构不合法时，引用该字段的 ②③ 检查跳过（非法性由 ① 负责报）。
 * - `dependsOn` 里任一检查未通过（失败或被跳过）的检查跳过。
 */
export function runGate(def: GateDefinition, input: GateInput): GateVerdict {
  const issues: CheckIssue[] = []
  const badFields = new Set<string>()
  const notPassed = new Set<string>()

  const structural = def.checks.filter((c) => STRUCTURAL_TYPES.has(c.type))
  const downstream = def.checks.filter((c) => !STRUCTURAL_TYPES.has(c.type))

  for (const check of structural) {
    const hit = evaluateCheck(check, input)
    if (hit !== null) {
      issues.push(hit)
      notPassed.add(check.id)
      for (const f of fieldsOf(check)) badFields.add(f)
    }
  }

  for (const check of downstream) {
    const skip =
      fieldsOf(check).some((f) => badFields.has(f)) ||
      (check.dependsOn ?? []).some((id) => notPassed.has(id))
    if (skip) {
      notPassed.add(check.id)
      continue
    }
    const hit = evaluateCheck(check, input)
    if (hit !== null) {
      issues.push(hit)
      notPassed.add(check.id)
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    pendingAiReview: def.aiReview ?? [],
  }
}
