import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import { extractDates, extractNumbers, numberAppears } from '../src/checks/grounding.js'
import { BAD_CASES, GOOD_FORM, SOURCE, TODAY } from './fixtures.js'

describe('门禁整体：挡坏放好', () => {
  it('好样例（正确抽取）应当全部通过', () => {
    const verdict = runGate({ form: GOOD_FORM, source: SOURCE, today: TODAY })
    expect(verdict.passed).toBe(true)
    expect(verdict.issues).toEqual([])
  })

  for (const c of BAD_CASES) {
    it(`坏样例应被拦下 — ${c.name}`, () => {
      const verdict = runGate({ form: c.form, source: SOURCE, today: TODAY })
      expect(verdict.passed).toBe(false)
      const codes = verdict.issues.map((i) => i.code)
      expect(codes).toContain(c.expectCode)
    })
  }
})

describe('③ 对照检查的取数与对照', () => {
  it('extractNumbers 提取金额/税额，忽略千分位', () => {
    expect(extractNumbers('金额 1,428.00 元 税额 24.23')).toEqual([1428.0, 24.23])
  })

  it('numberAppears 不把长发票号误当金额', () => {
    // 428 不是 24317000000123456789 的"金额级"数字，应基于分词而非子串
    expect(numberAppears(428.0, '号码 24317000000123456789')).toBe(false)
    expect(numberAppears(428.0, '金额 428.00 元')).toBe(true)
  })

  it('extractDates 规范化中文与 ISO 日期', () => {
    expect(extractDates('开票 2026年8月12日')).toContain('2026-08-12')
    expect(extractDates('date 2026-08-12')).toContain('2026-08-12')
  })
})
