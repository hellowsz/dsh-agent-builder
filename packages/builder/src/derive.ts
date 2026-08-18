/**
 * 确定性推导：TaskSpec → 门禁定义（YAML 文本）。
 * 这是"从勾选的合格标准造出门禁"的核心一步——纯函数，同一规格永远生成同一门禁。
 */
import { stringify } from 'yaml'
import { parseGate, type GateDefinition } from '@dsh-agent-builder/gate-engine'
import { type FieldSpec, type TaskSpec } from './spec.js'

function structuralChecksFor(f: FieldSpec): unknown[] {
  const checks: unknown[] = []
  const required = f.optional !== true
  switch (f.kind) {
    case 'text':
      if (required) checks.push({ id: `${f.name}_empty`, type: 'required', field: f.name, message: `${f.label}为空` })
      break
    case 'number':
      checks.push({ id: `${f.name}_invalid`, type: 'number', field: f.name, exclusiveMin: 0, message: `${f.label}必须是大于 0 的数字` })
      break
    case 'date':
      checks.push({ id: `${f.name}_malformed`, type: 'date', field: f.name, message: `${f.label}不是合法的 YYYY-MM-DD：{value}` })
      break
    case 'enum':
      checks.push({ id: `${f.name}_unknown`, type: 'enum', field: f.name, values: [...(f.values ?? [])], message: `${f.label}不在允许集合内：{value}` })
      break
  }
  return checks
}

function groundingCheckFor(f: FieldSpec): unknown | undefined {
  const wantGrounding = f.grounded ?? (f.kind === 'number' || f.kind === 'date' || f.kind === 'text')
  if (!wantGrounding) return undefined
  switch (f.kind) {
    case 'number':
      return { id: `${f.name}_not_grounded`, type: 'number-grounded', field: f.name, message: `${f.label}（{value}）在原文里找不到依据，疑似改数或编造` }
    case 'date':
      return { id: `${f.name}_not_grounded`, type: 'date-grounded', field: f.name, message: `${f.label}（{value}）在原文里找不到依据` }
    case 'text':
      return { id: `${f.name}_not_grounded`, type: 'text-grounded', field: f.name, message: `${f.label}（{value}）在原文里找不到，疑似编造` }
    case 'enum':
      return undefined // 枚举值是归类结论，不要求原文出现
  }
}

/** 生成门禁 YAML 文本。生成后立即用 parseGate 自检——生成器绝不产出非法门禁。 */
export function deriveGateYaml(spec: TaskSpec): string {
  const checks: unknown[] = []
  for (const f of spec.fields) checks.push(...structuralChecksFor(f))
  for (const r of spec.rules) {
    checks.push(
      r.type === 'compare'
        ? { id: r.id, type: 'compare', left: r.left, op: r.op, right: r.right, ...(r.factor !== undefined ? { factor: r.factor } : {}), ...(r.message !== undefined ? { message: r.message } : {}) }
        : { id: r.id, type: 'not-future', field: r.field, ...(r.message !== undefined ? { message: r.message } : {}) },
    )
  }
  for (const f of spec.fields) {
    const g = groundingCheckFor(f)
    if (g !== undefined) checks.push(g)
  }

  const doc = {
    version: 1,
    name: spec.name,
    description: `${spec.title}：${spec.description}`,
    checks,
    ...(spec.aiReview.length > 0 ? { aiReview: spec.aiReview.map((a) => ({ id: a.id, criteria: a.criteria })) } : {}),
  }
  const yamlText = stringify(doc)
  parseGate(yamlText) // 自检：不合法直接抛，快速失败
  return yamlText
}

/** 便捷：直接拿解析好的定义。 */
export function deriveGate(spec: TaskSpec): GateDefinition {
  return parseGate(deriveGateYaml(spec))
}
