/**
 * 对话收敛：用户的白话描述 → TaskSpec 草案（走 LLM）。
 * LLM 只负责起草；草案必须过 validateSpec 这道确定性关卡，过不了就带着问题重试。
 */
import { extractJsonRecord } from '@dsh-agent-builder/gate-engine'
import { type ChatClient } from '@dsh-agent-builder/evaluator'
import { validateSpec, type TaskSpec } from './spec.js'

const SYSTEM_PROMPT = [
  '你是"agent 搭建助手"的需求整理器。用户会用大白话描述想要一个什么样的信息整理 agent。',
  '你的任务：把描述整理成一份任务规格 JSON。只输出 JSON，不要输出其他文字。',
  '格式：',
  '{',
  '  "name": "kebab-case 英文标识",',
  '  "title": "中文任务名",',
  '  "description": "一句话：拿到什么原文，要产出什么",',
  '  "fields": [ { "name": "英文字段名", "label": "中文说明", "kind": "text|number|date|enum", "values": ["仅 enum 填"], "optional": false, "grounded": true } ],',
  '  "rules": [ { "id": "规则id", "type": "compare|not-future", "left": "字段", "op": "<=", "right": "字段", "factor": 0.2, "field": "not-future 用" } ],',
  '  "aiReview": [ { "id": "评审id", "criteria": "让独立评审员判断的标准" } ]',
  '}',
  '要求：',
  '1. 字段种类尽量往 number/date/enum 靠——它们能配确定性检查，比 text 稳。',
  '2. 金额类字段间的硬关系写进 rules，方向别写反：「税额不能大于金额」必须写 { "left": "税额字段", "op": "<=", "right": "金额字段" }（left 是小的一方）。日期类通常加 not-future。',
  '2b. grounded 表示"该值必须能在原文里原样找到"：编号/金额/日期类必须 true；可能需要归纳改写的描述类文字（如项目名称、摘要）设为 false。',
  '3. 只有确定性检查管不到的软判断（归类合理性、备注真实性）才进 aiReview，一般 1-2 条。',
  '4. 不要发明用户没提的字段。',
].join('\n')

/** 让 LLM 起草规格；带确定性校验与重试（把校验问题喂回去改）。 */
export async function draftSpec(client: ChatClient, userDescription: string, maxAttempts = 3): Promise<TaskSpec> {
  let feedback = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await client.chat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: feedback === '' ? userDescription : `${userDescription}\n\n上一稿的问题，请修正后重新输出完整 JSON：\n${feedback}` },
    ])
    // 容错：LLM 可能把 JSON 包在围栏/说明文字里
    const parsed = extractJsonRecord(text)
    if (parsed === undefined) {
      feedback = '输出里没有找到 JSON 对象，请只输出规格 JSON'
      continue
    }
    const candidate: TaskSpec = normalize(parsed)
    const problems = validateSpec(candidate)
    if (problems.length === 0) return candidate
    feedback = problems.join('\n')
  }
  throw new Error(`规格起草 ${maxAttempts} 次仍不合法：${feedback}`)
}

/** 驼峰/下划线 → kebab-case（机械可修的命名问题不浪费 LLM 重试）。 */
function toKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
}

/** 宽松归一：补默认值，剔除非预期字段。 */
function normalize(raw: unknown): TaskSpec {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const arr = (v: unknown): readonly Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : []
  return {
    name: typeof r.name === 'string' ? toKebab(r.name) : '',
    title: typeof r.title === 'string' ? r.title : '',
    description: typeof r.description === 'string' ? r.description : '',
    fields: arr(r.fields).map((f) => ({
      name: typeof f.name === 'string' ? toKebab(f.name) : '',
      label: typeof f.label === 'string' ? f.label : String(f.name ?? ''),
      kind: f.kind === 'number' || f.kind === 'date' || f.kind === 'enum' ? f.kind : 'text',
      ...(Array.isArray(f.values) ? { values: f.values.filter((v): v is string => typeof v === 'string') } : {}),
      ...(f.optional === true ? { optional: true } : {}),
      ...(typeof f.grounded === 'boolean' ? { grounded: f.grounded } : {}),
    })),
    rules: arr(r.rules).map((x) => ({
      id: typeof x.id === 'string' ? x.id : '',
      type: x.type === 'not-future' ? 'not-future' as const : 'compare' as const,
      ...(typeof x.left === 'string' ? { left: toKebab(x.left) } : {}),
      ...(x.op === '<=' || x.op === '<' || x.op === '>=' || x.op === '>' || x.op === '==' ? { op: x.op } : {}),
      ...(typeof x.right === 'string' ? { right: toKebab(x.right) } : {}),
      // factor≤0 使比较恒不成立,是模型笔误(真模型回归:曾输出 factor:0),机械丢弃
      ...(typeof x.factor === 'number' && x.factor > 0 ? { factor: x.factor } : {}),
      ...(typeof x.field === 'string' ? { field: toKebab(x.field) } : {}),
    })),
    aiReview: arr(r.aiReview).map((a) => ({
      id: typeof a.id === 'string' ? a.id : '',
      criteria: typeof a.criteria === 'string' ? a.criteria : '',
    })),
  }
}
