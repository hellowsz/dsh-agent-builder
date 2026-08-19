/**
 * 一键自检:从已加载的门禁定义自动衍生"拦截探针",验证判据真的在咬人。
 * 原则:自检必须可证伪——探针是"必须被拦"的坏输入,拦住指定问题码才算过。
 * 不调 LLM,毫秒级返回;它证明的是"挂载的门禁配置在岗且锋利",
 * 与徽章计数(证明拦截确实发生在真实会话里)互为补充。
 */
import { runGate, type CheckDef, type GateDefinition } from '@dsh-agent-builder/gate-engine'

export interface ProbeResult {
  readonly name: string
  /** 必须命中的问题码 */
  readonly expected: string
  /** 实际命中的问题码 */
  readonly issues: readonly string[]
  readonly pass: boolean
}

export interface SelfTestResult {
  readonly ok: boolean
  readonly probes: readonly ProbeResult[]
}

const PROBE_SOURCE = '自检探针原文:此文本刻意不包含任何待验数值与编号。'

function fieldOf(c: CheckDef): string {
  return c.type === 'compare' ? c.left : c.field
}

/** 跑一轮自检。探针按门禁里实际存在的检查类型衍生,一个类型一发。 */
export function runSelfTest(gate: GateDefinition, today: string): SelfTestResult {
  const probes: ProbeResult[] = []

  const probe = (name: string, expected: string, record: Record<string, unknown>): void => {
    const verdict = runGate(gate, { record, source: PROBE_SOURCE, today })
    const issues = verdict.issues.map((i) => i.code)
    probes.push({ name, expected, issues, pass: !verdict.passed && issues.includes(expected) })
  }

  // 探针1:数值失据(改数/编造场景)——找第一条 number-grounded
  const numG = gate.checks.find((c) => c.type === 'number-grounded')
  if (numG !== undefined) {
    probe('改数探针(数值在原文找不到→必须拦)', numG.id, { [fieldOf(numG)]: 999999.25 })
  }
  // 探针2:文本失据(编造编号场景)
  const txtG = gate.checks.find((c) => c.type === 'text-grounded')
  if (txtG !== undefined) {
    probe('编造探针(编号在原文找不到→必须拦)', txtG.id, { [fieldOf(txtG)]: '自检不存在编号XZ9527' })
  }
  // 探针3:结构缺失(空产出场景)——找第一条结构检查
  const structural = gate.checks.find((c) => ['required', 'number', 'date', 'enum'].includes(c.type))
  if (structural !== undefined) {
    probe('空产出探针(必填缺失→必须拦)', structural.id, {})
  }

  return { ok: probes.length > 0 && probes.every((p) => p.pass), probes }
}
