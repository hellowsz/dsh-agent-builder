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
      inject: (deps: readonly string[], cb: (s: { webServer: { tapIndex: (t: (html: string) => string) => void; register: (r: unknown) => void } }) => void) => {
        expect(deps).toEqual(['webServer'])
        cb({ webServer: { tapIndex: (t) => taps.push(t), register: () => undefined } })
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

describe('实时计数与状态端点', () => {
  function setupWeb() {
    const h = makeHarness()
    type Handler = (req: unknown, res: { writeHead(c: number, h: Record<string, string>): void; end(b: string): void }) => void
    const handlers = new Map<string, Handler>()
    const routes: string[] = []
    const ctx = {
      ...h.ctx,
      inject: (_d: readonly string[], cb: (s: { webServer: unknown }) => void) =>
        cb({ webServer: {
          tapIndex: () => undefined,
          register: (r: { path: string; handler: Handler }) => { routes.push(r.path); handlers.set(r.path, r.handler) },
        } }),
    }
    applyCore(ctx as never, { gateFile: writeGateFile(TEST_GATE_YAML), maxRetries: 1 })
    const call = (path: string) => {
      let body = ''
      handlers.get(path)!(undefined, { writeHead: () => undefined, end: (b: string) => { body = b } })
      return JSON.parse(body) as { name: string; fingerprint?: string; ok?: boolean; counters: { pass: number; block: number; steer: number } }
    }
    const status = () => call('/gate/status')
    return { ...h, routes, status, call }
  }

  it('注册 /gate/status;放行/打回/拦截计数实时可查', async () => {
    const h = setupWeb()
    expect(h.routes).toContain('/gate/status')
    expect(h.status().counters).toEqual({ pass: 0, block: 0, steer: 0, degraded: 0 })
    h.emitUser('发票 号码 INV20260812 金额 428.00 元')
    h.emitAssistant('```json\n{"amount": 428.0, "invoiceNo": "INV20260812"}\n```')
    await h.stopTurn(1) // 放行
    expect(h.status().counters.pass).toBe(1)
    h.emitAssistant('```json\n{"amount": 482.0, "invoiceNo": "INV20260812"}\n```')
    await h.stopTurn(2) // 改数→打回(用掉唯一重试)
    expect(h.status().counters.steer).toBe(1)
    h.emitAssistant('```json\n{"amount": 482.0, "invoiceNo": "INV20260812"}\n```')
    await h.stopTurn(2) // 重试用尽→拦截
    const c = h.status().counters
    expect(c.block).toBe(1)
    expect(h.status().name).toBe('test-reimbursement')
  })
})
