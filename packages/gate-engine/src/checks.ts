/**
 * 单条检查的求值：CheckDef + 输入 → 命中问题或 null。
 * 约定：前置条件不满足（如字段本身非法、缺原文）时跳过，避免重复报错——非法性由对应的 ① 检查负责报。
 */
import {
  type CheckDef,
  type CheckIssue,
  type CompareOp,
  type GateInput,
  type Layer,
} from './types.js'
import { extractDates, isValidDate, numberAppears } from './text.js'

const LAYER_OF: Record<CheckDef['type'], Layer> = {
  required: 'structural',
  number: 'structural',
  date: 'structural',
  enum: 'structural',
  compare: 'rule',
  'not-future': 'rule',
  'number-grounded': 'grounding',
  'text-grounded': 'grounding',
  'date-grounded': 'grounding',
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function compare(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case '<=': return a <= b
    case '<': return a < b
    case '>=': return a >= b
    case '>': return a > b
    case '==': return a === b
  }
}

function issue(def: CheckDef, field: string, fallback: string, value: unknown): CheckIssue {
  const message = (def.message ?? fallback).replaceAll('{value}', String(value))
  return { layer: LAYER_OF[def.type], field, code: def.id, message }
}

/** 求值一条检查。返回 null 表示通过或按约定跳过。 */
export function evaluateCheck(def: CheckDef, input: GateInput): CheckIssue | null {
  const { record, source, today } = input

  switch (def.type) {
    case 'required': {
      const v = asString(record[def.field])
      return v.trim() === '' ? issue(def, def.field, `字段 ${def.field} 为空`, v) : null
    }
    case 'number': {
      const n = asNumber(record[def.field])
      const bad =
        n === undefined ||
        (def.min !== undefined && n < def.min) ||
        (def.exclusiveMin !== undefined && n <= def.exclusiveMin) ||
        (def.max !== undefined && n > def.max)
      return bad
        ? issue(def, def.field, `字段 ${def.field} 不是合法数值：{value}`, record[def.field])
        : null
    }
    case 'date': {
      const v = asString(record[def.field])
      return isValidDate(v)
        ? null
        : issue(def, def.field, `字段 ${def.field} 不是合法的 YYYY-MM-DD：{value}`, v)
    }
    case 'enum': {
      const v = asString(record[def.field])
      return def.values.includes(v)
        ? null
        : issue(def, def.field, `字段 ${def.field} 的值不在允许集合内：{value}`, v)
    }
    case 'compare': {
      const left = asNumber(record[def.left])
      const right = asNumber(record[def.right])
      if (left === undefined || right === undefined) return null // 操作数非法，由 ① 报
      const bound = right * (def.factor ?? 1)
      return compare(left, def.op, bound)
        ? null
        : issue(def, def.left, `${def.left}（${left}）不满足 ${def.op} ${def.right}${def.factor !== undefined ? `×${def.factor}` : ''}（${bound}）`, left)
    }
    case 'not-future': {
      const v = asString(record[def.field])
      if (!isValidDate(v) || today === undefined || !isValidDate(today)) return null
      return v <= today
        ? null
        : issue(def, def.field, `日期（{value}）晚于今天（${today}）`, v)
    }
    case 'number-grounded': {
      const n = asNumber(record[def.field])
      if (n === undefined || n <= 0 || source === undefined) return null
      return numberAppears(n, source)
        ? null
        : issue(def, def.field, `数值（{value}）在原文里找不到依据，疑似改数或编造`, n)
    }
    case 'text-grounded': {
      const v = asString(record[def.field]).trim()
      if (v === '' || source === undefined) return null
      return source.includes(v)
        ? null
        : issue(def, def.field, `内容（{value}）在原文里找不到，疑似编造`, v)
    }
    case 'date-grounded': {
      const v = asString(record[def.field]).trim()
      if (v === '' || source === undefined) return null
      return extractDates(source).includes(v)
        ? null
        : issue(def, def.field, `日期（{value}）在原文里找不到依据`, v)
    }
  }
}
