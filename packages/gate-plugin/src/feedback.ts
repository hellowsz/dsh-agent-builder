/**
 * 把门禁裁决翻译成喂回 agent 的纠正指令文本。
 */
import { type AiReviewItem, type GateVerdict } from '@dsh-agent-builder/gate-engine'
import { type ReviewResult } from '@dsh-agent-builder/evaluator'

/** 未抽到结构化产出时的纠正指令。 */
export const NO_RECORD_FEEDBACK = [
  '【门禁拦截】没有在你的答复里找到结构化结果。',
  '请把最终结果放在一个 ```json 围栏里重新输出（只输出修正后的完整 JSON，字段齐全）。',
].join('\n')

/** ④ 评审未过（或评审通道出错）时的纠正指令。 */
export function buildReviewFeedback(
  result: ReviewResult,
  items: readonly AiReviewItem[],
  attempt: number,
  maxRetries: number,
): string {
  if (result.error !== undefined) {
    return [
      `【门禁拦截】独立评审暂时不可用（${result.error}），第 ${attempt}/${maxRetries} 次重试机会。`,
      '请把完整结果原样重新放在一个 ```json 围栏里输出，以便再次评审。',
    ].join('\n')
  }
  const byId = new Map(items.map((i) => [i.id, i.criteria]))
  const lines = result.findings
    .filter((f) => !f.passed)
    .map((f, n) => `${n + 1}. [评审:${f.id}] 标准：${byId.get(f.id) ?? ''}；结论：${f.reason}`)
  return [
    `【门禁拦截】独立评审未通过（第 ${attempt}/${maxRetries} 次重试机会）：`,
    ...lines,
    '',
    '请按以上标准修正——不得编造原文里不存在的内容。',
    '修正后把完整结果重新放在一个 ```json 围栏里输出。',
  ].join('\n')
}

/** 检查未过时的纠正指令：列出每条问题，要求改后重发。 */
export function buildFeedback(verdict: GateVerdict, attempt: number, maxRetries: number): string {
  const lines = verdict.issues.map((i, n) => `${n + 1}. [${i.field}] ${i.message}`)
  return [
    `【门禁拦截】你的产出未通过验收（第 ${attempt}/${maxRetries} 次重试机会）：`,
    ...lines,
    '',
    '请只修正以上问题——不要改动没有被指出的字段,尤其不得编造原文里不存在的内容。',
    '修正后把完整结果重新放在一个 ```json 围栏里输出。',
  ].join('\n')
}
