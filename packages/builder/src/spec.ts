/**
 * 任务规格：对话收敛的产物，也是后续一切生成（门禁/提示词/preset）的唯一输入。
 * 结构化、可校验——保证"聊出来的东西"能被确定性地翻译成配置。
 */

/** 输出字段的种类，决定给它配哪些默认检查。 */
export type FieldKind = 'text' | 'number' | 'date' | 'enum'

export interface FieldSpec {
  /** 字段名（英文标识，进 JSON） */
  readonly name: string
  /** 给人看的中文说明 */
  readonly label: string
  readonly kind: FieldKind
  /** kind=enum 时的允许值 */
  readonly values?: readonly string[]
  /** 是否必填（默认 true） */
  readonly optional?: boolean
  /** 是否要求"在原文里找得到依据"（③ 对照），默认按 kind：number/date/text 为 true */
  readonly grounded?: boolean
}

/** 字段间的硬约束（② 规则）。 */
export interface RuleSpec {
  readonly id: string
  readonly type: 'compare' | 'not-future'
  readonly left?: string
  readonly op?: '<=' | '<' | '>=' | '>' | '=='
  readonly right?: string
  readonly factor?: number
  readonly field?: string
  readonly message?: string
}

/** ④ AI 评审条目。 */
export interface ReviewSpec {
  readonly id: string
  readonly criteria: string
}

/** 完整任务规格。 */
export interface TaskSpec {
  /** 英文标识（做文件名/门禁名） */
  readonly name: string
  /** 中文任务名 */
  readonly title: string
  /** 任务一句话描述：agent 拿到什么、要产出什么 */
  readonly description: string
  readonly fields: readonly FieldSpec[]
  readonly rules: readonly RuleSpec[]
  readonly aiReview: readonly ReviewSpec[]
}

const NAME_RE = /^[a-z][a-z0-9-]*$/

/** 校验规格（系统边界：LLM 生成或人工编辑的都要过这关）。返回问题列表，空数组=合法。 */
export function validateSpec(spec: TaskSpec): readonly string[] {
  const problems: string[] = []
  if (!NAME_RE.test(spec.name)) problems.push(`name 必须是小写字母开头的 kebab-case：${spec.name}`)
  if (spec.title.trim() === '') problems.push('title 为空')
  if (spec.description.trim() === '') problems.push('description 为空')
  if (spec.fields.length === 0) problems.push('至少要有一个输出字段')

  const seen = new Set<string>()
  for (const f of spec.fields) {
    if (!NAME_RE.test(f.name)) problems.push(`字段名必须是 kebab-case/小写：${f.name}`)
    if (seen.has(f.name)) problems.push(`字段名重复：${f.name}`)
    seen.add(f.name)
    if (f.kind === 'enum' && (f.values === undefined || f.values.length === 0)) {
      problems.push(`enum 字段 ${f.name} 缺少 values`)
    }
  }
  for (const r of spec.rules) {
    if (r.type === 'compare') {
      if (r.left === undefined || r.right === undefined || r.op === undefined) {
        problems.push(`compare 规则 ${r.id} 缺少 left/op/right`)
      } else {
        if (!seen.has(r.left)) problems.push(`规则 ${r.id} 引用了不存在的字段：${r.left}`)
        if (!seen.has(r.right)) problems.push(`规则 ${r.id} 引用了不存在的字段：${r.right}`)
      }
    } else if (r.field === undefined || !seen.has(r.field)) {
      problems.push(`规则 ${r.id} 引用了不存在的字段：${r.field ?? '(缺 field)'}`)
    }
  }
  return problems
}
