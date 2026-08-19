/**
 * 样例自探索：不让用户出题——LLM 根据任务规格自己编造真实感样例(正例)和无关反例,
 * 交给稳定性流水线去跑,用户只需确认最终产物。
 * 样例是编造的这一点必须诚实呈现;鼓励用户补充真实样例。
 */
import { extractJsonRecord } from '@dsh-agent-builder/gate-engine'
import { type ChatClient } from '@dsh-agent-builder/evaluator'
import { type Sample } from './stability.js'
import { type TaskSpec } from './spec.js'

const SYSTEM_PROMPT = [
  '你是测试样例设计师。给你一个"信息整理任务"的规格,你负责编造测试用的输入原文。',
  '要求:',
  '1. 编 GOOD 条真实感十足的原文(正例):像真实世界里用户会贴进来的那种文字,',
  '   必须包含规格里每个必填字段能抽取到的信息,数值/编号/日期要具体且自洽。',
  '2. 编 1 条与任务完全无关的文字(反例):用来验证系统会拒绝无关输入。',
  '3. 正例之间要有差异(不同商户/数值/写法),不要雷同。',
  '4. 只输出 JSON:{"good":["原文1","原文2"],"bad":["无关文字"]},不要输出其他内容。',
].join('\n')

function buildUserPrompt(spec: TaskSpec, goodCount: number): string {
  const fields = spec.fields
    .map((f) => `- ${f.label}(${f.kind}${f.kind === 'enum' ? `:${(f.values ?? []).join('/')}` : ''}${f.optional === true ? ',可空' : ''})`)
    .join('\n')
  return [
    `任务:${spec.title} —— ${spec.description}`,
    `需要抽取的字段:`,
    fields,
    '',
    `请编 ${goodCount} 条正例和 1 条反例。`,
  ].join('\n')
}

function parseSamples(raw: Record<string, unknown>, goodCount: number): Sample[] | undefined {
  const good = Array.isArray(raw.good) ? raw.good.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []
  const bad = Array.isArray(raw.bad) ? raw.bad.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []
  if (good.length === 0) return undefined
  if (new Set(good.map((s) => s.trim())).size !== good.length) return undefined // 雷同重试
  const samples: Sample[] = good.slice(0, goodCount).map((source, i) => ({
    name: `探索样例${i + 1}`,
    source: source.trim(),
    expect: 'pass' as const,
    origin: 'synthetic' as const,
  }))
  const firstBad = bad[0]
  if (firstBad !== undefined) samples.push({ name: '无关反例', source: firstBad.trim(), expect: 'block', origin: 'synthetic' })
  return samples
}

/** 让 LLM 自造样例(正例 goodCount 条 + 反例 1 条),带确定性校验与重试。 */
export async function generateSamples(
  client: ChatClient,
  spec: TaskSpec,
  goodCount = 2,
  maxAttempts = 3,
): Promise<Sample[]> {
  let lastProblem = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await client.chat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: lastProblem === '' ? buildUserPrompt(spec, goodCount) : `${buildUserPrompt(spec, goodCount)}\n\n上一稿的问题:${lastProblem},请重新输出完整 JSON。` },
    ])
    const raw = extractJsonRecord(text)
    if (raw === undefined) { lastProblem = '输出里没有 JSON'; continue }
    const samples = parseSamples(raw, goodCount)
    if (samples !== undefined) return samples
    lastProblem = 'good 为空或正例雷同'
  }
  throw new Error(`样例自探索 ${maxAttempts} 次仍未产出合格样例:${lastProblem}`)
}
