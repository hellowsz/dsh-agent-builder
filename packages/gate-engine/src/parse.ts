/**
 * 门禁文件解析与校验：YAML 文本 → GateDefinition。
 * 系统边界输入，逐项校验、快速失败、错误信息说清哪条检查哪里不对。
 */
import { parse as parseYaml } from 'yaml'
import { type AiReviewItem, type CheckDef, type GateDefinition } from './types.js'

/** 门禁文件不合法时抛出。 */
export class GateParseError extends Error {
  constructor(message: string) {
    super(`门禁文件不合法：${message}`)
    this.name = 'GateParseError'
  }
}

const CHECK_TYPES = new Set([
  'required', 'number', 'date', 'enum',
  'compare', 'not-future',
  'number-grounded', 'text-grounded', 'date-grounded',
])
const COMPARE_OPS = new Set(['<=', '<', '>=', '>', '=='])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.trim() === '') throw new GateParseError(`${where} 缺少字符串字段 ${key}`)
  return v
}

function optionalNumber(obj: Record<string, unknown>, key: string, where: string): number | undefined {
  const v = obj[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new GateParseError(`${where} 的 ${key} 必须是数字`)
  return v
}


function parseDependsOn(v: unknown, where: string): readonly string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim() !== '')) {
    throw new GateParseError(`${where} 的 dependsOn 必须是非空字符串数组`)
  }
  return v
}

function parseCheck(raw: unknown, index: number): CheckDef {
  const where = `checks[${index}]`
  if (!isRecord(raw)) throw new GateParseError(`${where} 必须是对象`)
  const id = requireString(raw, 'id', where)
  const type = requireString(raw, 'type', where)
  if (!CHECK_TYPES.has(type)) throw new GateParseError(`${where}（${id}）的 type 未知：${type}`)
  const message = raw.message === undefined ? undefined : requireString(raw, 'message', where)
  const dependsOn = parseDependsOn(raw.dependsOn, `${where}（${id}）`)

  switch (type) {
    case 'required':
    case 'date':
    case 'not-future':
    case 'number-grounded':
    case 'text-grounded':
    case 'date-grounded':
      return { id, type, message, dependsOn, field: requireString(raw, 'field', `${where}（${id}）`) } as CheckDef
    case 'number':
      return {
        id, type, message, dependsOn,
        field: requireString(raw, 'field', `${where}（${id}）`),
        min: optionalNumber(raw, 'min', `${where}（${id}）`),
        exclusiveMin: optionalNumber(raw, 'exclusiveMin', `${where}（${id}）`),
        max: optionalNumber(raw, 'max', `${where}（${id}）`),
      }
    case 'enum': {
      const values = raw.values
      if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === 'string')) {
        throw new GateParseError(`${where}（${id}）的 values 必须是非空字符串数组`)
      }
      return { id, type, message, dependsOn, field: requireString(raw, 'field', `${where}（${id}）`), values }
    }
    case 'compare': {
      const op = requireString(raw, 'op', `${where}（${id}）`)
      if (!COMPARE_OPS.has(op)) throw new GateParseError(`${where}（${id}）的 op 未知：${op}`)
      return {
        id, type, message, dependsOn,
        left: requireString(raw, 'left', `${where}（${id}）`),
        op: op as CheckDef extends never ? never : '<=',
        right: requireString(raw, 'right', `${where}（${id}）`),
        factor: optionalNumber(raw, 'factor', `${where}（${id}）`),
      } as CheckDef
    }
    default:
      throw new GateParseError(`${where} 不可达的 type：${type}`)
  }
}

function parseAiReview(raw: unknown): readonly AiReviewItem[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new GateParseError('aiReview 必须是数组')
  return raw.map((item, i) => {
    if (!isRecord(item)) throw new GateParseError(`aiReview[${i}] 必须是对象`)
    return {
      id: requireString(item, 'id', `aiReview[${i}]`),
      criteria: requireString(item, 'criteria', `aiReview[${i}]`),
    }
  })
}

/** 解析一份门禁文件（YAML 文本）。 */
export function parseGate(yamlText: string): GateDefinition {
  let raw: unknown
  try {
    raw = parseYaml(yamlText)
  } catch (e) {
    throw new GateParseError(`YAML 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!isRecord(raw)) throw new GateParseError('顶层必须是对象')
  if (raw.version !== 1) throw new GateParseError(`version 必须是 1，收到：${String(raw.version)}`)
  const name = requireString(raw, 'name', '顶层')
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    throw new GateParseError('checks 必须是非空数组')
  }
  const checks = raw.checks.map(parseCheck)

  const ids = new Set<string>()
  for (const c of checks) {
    if (ids.has(c.id)) throw new GateParseError(`检查 id 重复：${c.id}`)
    ids.add(c.id)
  }
  for (const c of checks) {
    for (const dep of c.dependsOn ?? []) {
      if (dep === c.id) throw new GateParseError(`检查 ${c.id} 的 dependsOn 引用了自己`)
      if (!ids.has(dep)) throw new GateParseError(`检查 ${c.id} 的 dependsOn 引用了不存在的检查：${dep}`)
    }
  }

  return {
    version: 1,
    name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    checks,
    aiReview: parseAiReview(raw.aiReview),
  }
}
