/**
 * 等价性验证：声明式门禁文件（经通用引擎执行）必须与手写判据给出一致裁决。
 * 手写判据是"标准答案"——引擎配置版通过此测试，说明门禁外置成文件是成立的。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseGate, runGate as runEngineGate } from '@dsh-agent-builder/gate-engine'
import { runGate as runHandwritten } from '../src/gate.js'
import { BAD_CASES, GOOD_FORM, SOURCE, TODAY } from './fixtures.js'

const here = dirname(fileURLToPath(import.meta.url))
const GATE = parseGate(readFileSync(join(here, '..', 'reimbursement.gate.yaml'), 'utf8'))

function engineVerdict(form: Record<string, unknown>) {
  return runEngineGate(GATE, { record: form, source: SOURCE, today: TODAY })
}

describe('声明式门禁 ≡ 手写判据', () => {
  it('好样例：两者都放行', () => {
    const hand = runHandwritten({ form: GOOD_FORM, source: SOURCE, today: TODAY })
    const eng = engineVerdict({ ...GOOD_FORM })
    expect(hand.passed).toBe(true)
    expect(eng.passed).toBe(true)
  })

  for (const c of BAD_CASES) {
    it(`坏样例：两者都拦下且问题码一致 — ${c.name}`, () => {
      const hand = runHandwritten({ form: c.form, source: SOURCE, today: TODAY })
      const eng = engineVerdict({ ...c.form })
      expect(hand.passed).toBe(false)
      expect(eng.passed).toBe(false)
      expect(eng.issues.map((i) => i.code)).toContain(c.expectCode)
      // 两边命中的问题码集合一致（顺序无关）
      expect(new Set(eng.issues.map((i) => i.code))).toEqual(new Set(hand.issues.map((i) => i.code)))
    })
  }

  it('门禁文件带出 ④ AI 评审待办', () => {
    const eng = engineVerdict({ ...GOOD_FORM })
    expect(eng.pendingAiReview.map((a) => a.id)).toEqual(['category_sensible', 'note_sensible'])
  })
})
