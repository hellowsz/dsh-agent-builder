import { describe, expect, it } from 'vitest'
import { parseGate } from '../src/parse.js'
import { runGate } from '../src/engine.js'

const GATE = parseGate(`
version: 1
name: demo
checks:
  - { id: name_required, type: required, field: name }
  - { id: qty_number, type: number, field: qty, exclusiveMin: 0, max: 100 }
  - { id: day_date, type: date, field: day }
  - { id: kind_enum, type: enum, field: kind, values: [甲, 乙] }
  - { id: part_le_total, type: compare, left: part, op: '<=', right: total }
  - { id: part_ratio, type: compare, left: part, op: '<=', right: total, factor: 0.5 }
  - { id: day_not_future, type: not-future, field: day }
  - { id: qty_grounded, type: number-grounded, field: qty }
  - { id: name_grounded, type: text-grounded, field: name }
  - { id: day_grounded, type: date-grounded, field: day }
aiReview:
  - { id: overall, criteria: 整体是否合理 }
`)

const GOOD = {
  record: { name: '样品', qty: 5, day: '2026-08-10', kind: '甲', part: 2, total: 10 },
  source: '样品 数量 5 件，日期 2026年8月10日',
  today: '2026-08-18',
}

describe('runGate：通用引擎', () => {
  it('好记录全过，并带出 aiReview 待办', () => {
    const v = runGate(GATE, GOOD)
    expect(v.passed).toBe(true)
    expect(v.issues).toEqual([])
    expect(v.pendingAiReview.map((a) => a.id)).toEqual(['overall'])
  })

  const failing: Array<[string, Record<string, unknown>, string]> = [
    ['空字段', { ...GOOD.record, name: '' }, 'name_required'],
    ['数值越界', { ...GOOD.record, qty: 0 }, 'qty_number'],
    ['非法日期', { ...GOOD.record, day: '2026-13-01' }, 'day_date'],
    ['集合外取值', { ...GOOD.record, kind: '丙' }, 'kind_enum'],
    ['比较不成立', { ...GOOD.record, part: 20 }, 'part_le_total'],
    ['带系数比较不成立', { ...GOOD.record, part: 6 }, 'part_ratio'],
    ['未来日期', { ...GOOD.record, day: '2027-01-01' }, 'day_not_future'],
    ['数值失据', { ...GOOD.record, qty: 7 }, 'qty_grounded'],
    ['文本失据', { ...GOOD.record, name: '假样品' }, 'name_grounded'],
  ]

  for (const [name, record, code] of failing) {
    it(`拦下：${name} → ${code}`, () => {
      const v = runGate(GATE, { ...GOOD, record })
      expect(v.passed).toBe(false)
      expect(v.issues.map((i) => i.code)).toContain(code)
    })
  }

  it('操作数非法时 compare 跳过（由 ① 报），不重复报错', () => {
    const v = runGate(GATE, { ...GOOD, record: { ...GOOD.record, part: '不是数' } })
    const codes = v.issues.map((i) => i.code)
    expect(codes).not.toContain('part_le_total')
    expect(codes).not.toContain('part_ratio')
  })

  it('缺 source 时 grounding 跳过', () => {
    const v = runGate(GATE, { record: GOOD.record, today: GOOD.today })
    expect(v.passed).toBe(true)
  })

  it('message 模板 {value} 生效', () => {
    const gate = parseGate(`
version: 1
name: t
checks:
  - { id: k, type: enum, field: kind, values: [甲], message: "类别不认识：{value}" }
`)
    const v = runGate(gate, { record: { kind: '丁' } })
    expect(v.issues[0]?.message).toBe('类别不认识：丁')
  })
})
