/**
 * ④ AI 评审：独立评审 agent。
 * 与干活的 agent 完全分离——只看「原文 + 产出 + 评审标准」，逐条给出 通过/不通过 + 理由。
 * 评审 LLM 输出必须是 JSON；解析失败按"评审失败"处理，绝不静默放行。
 */
import { extractJsonRecord, type AiReviewItem } from '@dsh-agent-builder/gate-engine'
import { type ChatClient, type ChatMessage } from './llm.js'

export { createDeepSeekClient, type ChatClient, type ChatMessage, type DeepSeekConfig } from './llm.js'
export { createDshHeadlessClient, type DshHeadlessConfig } from './dsh-client.js'

/** 一条评审结论。 */
export interface ReviewFinding {
  readonly id: string
  readonly passed: boolean
  readonly reason: string
}

/** 一次评审的结果。error 非空表示评审本身失败（网络/格式），此时 findings 为空且不可视为通过。 */
export interface ReviewResult {
  readonly passed: boolean
  readonly findings: readonly ReviewFinding[]
  readonly error?: string
}

export interface ReviewInput {
  /** 用户的原始输入文字 */
  readonly source: string
  /** 待评审的结构化产出 */
  readonly record: Readonly<Record<string, unknown>>
  /** 门禁里声明的 ④ 评审条目 */
  readonly items: readonly AiReviewItem[]
}

const SYSTEM_PROMPT = [
  '你是一个严格的独立评审员。给你：用户的原始输入、另一个 AI 整理出的结构化结果、若干条评审标准。',
  '你的任务：逐条判断结果是否满足标准。',
  '铁律：',
  '1. 只依据原始输入判断，结果里任何在原始输入中找不到依据的内容都算不满足。',
  '2. 拿不准就判不通过（宁可错杀）。',
  '3. 只输出 JSON，格式：{"findings":[{"id":"<标准id>","passed":true|false,"reason":"<一句话理由>"}]}，不得输出其他文字。',
].join('\n')

function buildUserPrompt(input: ReviewInput): string {
  const criteria = input.items.map((i) => `- id=${i.id}：${i.criteria}`).join('\n')
  return [
    '【原始输入】',
    input.source,
    '',
    '【待评审的结构化结果】',
    JSON.stringify(input.record, null, 2),
    '',
    '【评审标准（逐条判断）】',
    criteria,
  ].join('\n')
}

function parseFindings(text: string, items: readonly AiReviewItem[]): readonly ReviewFinding[] {
  // 容错：评审 LLM 可能把 JSON 包在围栏/说明文字里
  const raw: unknown = extractJsonRecord(text)
  if (typeof raw !== 'object' || raw === null) throw new Error('评审输出里没有 JSON 对象')
  const findings = (raw as { findings?: unknown }).findings
  if (!Array.isArray(findings)) throw new Error('评审输出缺少 findings 数组')

  const wanted = new Set(items.map((i) => i.id))
  const out: ReviewFinding[] = []
  for (const f of findings) {
    if (typeof f !== 'object' || f === null) continue
    const { id, passed, reason } = f as { id?: unknown; passed?: unknown; reason?: unknown }
    if (typeof id !== 'string' || !wanted.has(id) || typeof passed !== 'boolean') continue
    out.push({ id, passed, reason: typeof reason === 'string' ? reason : '' })
  }
  // 每条标准都必须有结论——缺了算评审失败，不能静默当通过
  const covered = new Set(out.map((f) => f.id))
  const missing = items.filter((i) => !covered.has(i.id)).map((i) => i.id)
  if (missing.length > 0) throw new Error(`评审输出缺少标准的结论：${missing.join(', ')}`)
  return out
}

/**
 * 跑一次独立评审。items 为空直接通过（没有 ④ 条目要评）。
 * 评审 LLM 输出不合格式时纠偏重问一次(明确指出问题),仍不行才判评审失败。
 */
export async function review(client: ChatClient, input: ReviewInput): Promise<ReviewResult> {
  if (input.items.length === 0) return { passed: true, findings: [] }
  const base: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(input) },
  ]
  let lastError = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages: ChatMessage[] =
      attempt === 1
        ? base
        : [...base, { role: 'user', content: `你上一次的输出不符合要求（${lastError}）。请严格只输出 JSON，格式 {"findings":[{"id":"...","passed":true|false,"reason":"..."}]}，每条标准都要有结论，不要输出任何解释文字。` }]
    try {
      const text = await client.chat(messages)
      const findings = parseFindings(text, input.items)
      return { passed: findings.every((f) => f.passed), findings }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return { passed: false, findings: [], error: lastError }
}
