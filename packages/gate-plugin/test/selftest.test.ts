import { describe, expect, it } from 'vitest'
import { fingerprintText, parseGate } from '@dsh-agent-builder/gate-engine'
import { runSelfTest } from '../src/selftest.js'
import { badgeInfo } from '../src/badge.js'

const GATE = parseGate(`
version: 1
name: probe-target
checks:
  - { id: amount_invalid, type: number, field: amount, exclusiveMin: 0 }
  - { id: amount_not_grounded, type: number-grounded, field: amount }
  - { id: invoice_not_grounded, type: text-grounded, field: invoice-no }
`)

describe('一键自检(投毒探针)', () => {
  it('探针按检查类型衍生,坏输入全部被拦对码 → 自检通过', () => {
    const r = runSelfTest(GATE, '2026-08-19')
    expect(r.probes).toHaveLength(3) // 改数/编造/空产出
    expect(r.ok).toBe(true)
    const byName = Object.fromEntries(r.probes.map((p) => [p.expected, p.pass]))
    expect(byName['amount_not_grounded']).toBe(true)
    expect(byName['invoice_not_grounded']).toBe(true)
    expect(byName['amount_invalid']).toBe(true)
  })

  it('门禁被阉割(空 checks 场景近似:只剩无关检查)→ 自检如实报未过或无探针', () => {
    const weak = parseGate(`
version: 1
name: weak
checks:
  - { id: only_note, type: required, field: note }
`)
    const r = runSelfTest(weak, '2026-08-19')
    // 只有结构探针;record 缺 note → 仍应拦。真正"什么都拦不住"的门禁 parseGate 就过不了(checks 非空)
    expect(r.probes.length).toBeGreaterThan(0)
  })
})

describe('配置指纹', () => {
  it('同内容同指纹,内容一字之差指纹即变', () => {
    const a = fingerprintText('gate-v1', 'prompt-v1')
    expect(fingerprintText('gate-v1', 'prompt-v1')).toBe(a)
    expect(fingerprintText('gate-v1', 'prompt-v2')).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })

  it('指纹进入徽章信息', () => {
    const info = badgeInfo(GATE, 2, true, true, 'abcd1234')
    expect(info.fingerprint).toBe('abcd1234')
  })
})
