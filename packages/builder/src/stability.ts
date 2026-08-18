/**
 * 稳定性验证：拿一批样例跑工作 agent + 门禁（含 ④ 独立评审），出诚实的稳定性报告。
 * 固化前的必经关卡——不接受"跑通一次就固定"。
 */
import {
  extractJsonRecord,
  runGate,
  type GateDefinition,
} from '@dsh-agent-builder/gate-engine'
import { review, type ChatClient, type ReviewResult } from '@dsh-agent-builder/evaluator'
import { deriveWorkPrompt } from './prompt.js'
import { type TaskSpec } from './spec.js'

/** 一个测试样例：原文 + 期望（good=应通过 / bad=应被拦下）。 */
export interface Sample {
  readonly name: string
  readonly source: string
  readonly expect: 'pass' | 'block'
}

/** 单个样例的运行结果。 */
export interface SampleResult {
  readonly name: string
  readonly expect: 'pass' | 'block'
  /** 实际：pass=门禁+评审全过 / block=被拦 / error=运行异常 */
  readonly actual: 'pass' | 'block' | 'error'
  /** 与期望是否一致 */
  readonly ok: boolean
  readonly issues: readonly string[]
  readonly reviewError?: string
}

/** 稳定性报告。 */
export interface StabilityReport {
  readonly total: number
  readonly matched: number
  /** matched/total */
  readonly matchRate: number
  readonly results: readonly SampleResult[]
}

export interface RunOptions {
  /** 工作 agent 用的 LLM */
  readonly workClient: ChatClient
  /** ④ 独立评审用的 LLM（应与工作 agent 分开的会话/客户端） */
  readonly reviewClient: ChatClient
  /** 固定"今天"，YYYY-MM-DD */
  readonly today: string
}

/** 跑一个样例：工作 agent 产出 → 确定性门禁 → ④ 独立评审。 */
export async function runSample(
  spec: TaskSpec,
  gate: GateDefinition,
  sample: Sample,
  options: RunOptions,
): Promise<SampleResult> {
  const base = { name: sample.name, expect: sample.expect }
  try {
    const answer = await options.workClient.chat([
      { role: 'system', content: deriveWorkPrompt(spec) },
      { role: 'user', content: sample.source },
    ])
    const record = extractJsonRecord(answer)
    if (record === undefined) {
      return { ...base, actual: 'block', ok: sample.expect === 'block', issues: ['no_structured_output'] }
    }
    const verdict = runGate(gate, { record, source: sample.source, today: options.today })
    if (!verdict.passed) {
      const issues = verdict.issues.map((i) => i.code)
      return { ...base, actual: 'block', ok: sample.expect === 'block', issues }
    }
    const reviewed: ReviewResult = await review(options.reviewClient, {
      source: sample.source,
      record,
      items: verdict.pendingAiReview,
    })
    if (!reviewed.passed) {
      const issues = reviewed.findings.filter((f) => !f.passed).map((f) => `review:${f.id}`)
      return {
        ...base,
        actual: 'block',
        ok: sample.expect === 'block',
        issues: issues.length > 0 ? issues : ['review_failed'],
        ...(reviewed.error !== undefined ? { reviewError: reviewed.error } : {}),
      }
    }
    return { ...base, actual: 'pass', ok: sample.expect === 'pass', issues: [] }
  } catch (e) {
    return { ...base, actual: 'error', ok: false, issues: [e instanceof Error ? e.message : String(e)] }
  }
}

/** 跑整批样例出报告。串行跑，稳定优先。 */
export async function runStability(
  spec: TaskSpec,
  gate: GateDefinition,
  samples: readonly Sample[],
  options: RunOptions,
): Promise<StabilityReport> {
  const results: SampleResult[] = []
  for (const s of samples) results.push(await runSample(spec, gate, s, options))
  const matched = results.filter((r) => r.ok).length
  return {
    total: results.length,
    matched,
    matchRate: results.length === 0 ? 0 : matched / results.length,
    results,
  }
}

/** 报告转成给人看的 markdown。 */
export function renderReport(spec: TaskSpec, report: StabilityReport): string {
  const lines = [
    `# ${spec.title} · 稳定性报告`,
    '',
    `- 样例数：${report.total}`,
    `- 符合预期：${report.matched}/${report.total}（${Math.round(report.matchRate * 100)}%）`,
    '',
    '| 样例 | 预期 | 实际 | 一致 | 问题 |',
    '|---|---|---|---|---|',
    ...report.results.map((r) =>
      `| ${r.name} | ${r.expect} | ${r.actual} | ${r.ok ? '✓' : '✗'} | ${r.issues.join(', ') || '-'} |`,
    ),
  ]
  return lines.join('\n')
}
