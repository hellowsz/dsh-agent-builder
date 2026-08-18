import { describe, expect, it } from 'vitest'
import { GateParseError, parseGate } from '../src/parse.js'

const MINIMAL = `
version: 1
name: demo
checks:
  - id: a_required
    type: required
    field: a
`

describe('parseGate：边界校验', () => {
  it('解析最小合法门禁', () => {
    const def = parseGate(MINIMAL)
    expect(def.name).toBe('demo')
    expect(def.checks).toHaveLength(1)
    expect(def.aiReview).toEqual([])
  })

  it('拒绝错误 version', () => {
    expect(() => parseGate('version: 2\nname: x\nchecks:\n  - id: a\n    type: required\n    field: f'))
      .toThrow(GateParseError)
  })

  it('拒绝空 checks', () => {
    expect(() => parseGate('version: 1\nname: x\nchecks: []')).toThrow(/checks/)
  })

  it('拒绝未知检查类型', () => {
    expect(() => parseGate('version: 1\nname: x\nchecks:\n  - id: a\n    type: magic\n    field: f'))
      .toThrow(/type 未知/)
  })

  it('拒绝重复 id', () => {
    const dup = `
version: 1
name: x
checks:
  - { id: a, type: required, field: f }
  - { id: a, type: required, field: g }
`
    expect(() => parseGate(dup)).toThrow(/id 重复/)
  })

  it('拒绝非法 compare op', () => {
    expect(() =>
      parseGate('version: 1\nname: x\nchecks:\n  - { id: a, type: compare, left: x, op: "~", right: y }'),
    ).toThrow(/op 未知/)
  })

  it('解析 aiReview 条目', () => {
    const def = parseGate(`${MINIMAL}\naiReview:\n  - id: sensible\n    criteria: 结果是否合理\n`)
    expect(def.aiReview).toEqual([{ id: 'sensible', criteria: '结果是否合理' }])
  })
})
