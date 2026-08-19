import { describe, expect, it } from 'vitest'
import { applyCore } from '../src/index.js'
import { badgeInfo, badgeHtml } from '../src/badge.js'
import { parseGate } from '@dsh-agent-builder/gate-engine'
import { makeHarness, writeGateFile, TEST_GATE_YAML } from './harness.js'

const GATE = parseGate(`
version: 1
name: invoice-sorter
description: 发票整理
checks:
  - { id: a, type: number, field: amount, exclusiveMin: 0 }
  - { id: b, type: compare, left: amount, op: '<=', right: amount }
  - { id: c, type: number-grounded, field: amount }
aiReview:
  - { id: r1, criteria: 合理性 }
`)

describe('装配可观测徽章', () => {
  it('badgeInfo 按层归类统计', () => {
    const info = badgeInfo(GATE, 2, true, true)
    expect(info.layers).toEqual({ structural: 1, rule: 1, grounding: 1, aiReview: 1 })
    expect(info.name).toBe('invoice-sorter')
  })

  it('badgeHtml 自包含且转义 <(防注入截断)', () => {
    const html = badgeHtml(badgeInfo({ ...GATE, description: '</script><b>x' } as never, 2, false, false))
    expect(html).toContain('gate-badge')
    expect(html).not.toContain('</script><b>x') // 已转义
    expect(html).toContain('已装配')
  })

  it('web 环境:tapIndex 注入含配置名与四层统计', () => {
    const h = makeHarness()
    const taps: Array<(html: string) => string> = []
    const ctx = {
      ...h.ctx,
      inject: (deps: readonly string[], cb: (s: { webServer: { tapIndex: (t: (html: string) => string) => void } }) => void) => {
        expect(deps).toEqual(['webServer'])
        cb({ webServer: { tapIndex: (t) => taps.push(t) } })
      },
    }
    applyCore(ctx as never, { gateFile: writeGateFile(TEST_GATE_YAML), maxRetries: 2 })
    expect(taps).toHaveLength(1)
    const out = taps[0]!('<html><body>app</body></html>')
    expect(out).toContain('"name":"test-reimbursement"')
    expect(out).toContain('已装配')
    expect(out).toContain('①结构')
    expect(out.indexOf('</body>')).toBeGreaterThan(out.indexOf('gate-badge'))
  })

  it('headless 环境(无 inject):不崩、门禁照常工作', async () => {
    const h = makeHarness() // ctx 没有 inject
    applyCore(h.ctx as never, { gateFile: writeGateFile(TEST_GATE_YAML), maxRetries: 2 })
    h.emitUser('发票 号码 INV1 金额 428.00 元')
    h.emitAssistant('```json\n{"amount": 428.0, "invoiceNo": "INV1"}\n```')
    await h.stopTurn(1)
    expect(h.logs.some((l) => l.includes('通过'))).toBe(true)
  })
})
