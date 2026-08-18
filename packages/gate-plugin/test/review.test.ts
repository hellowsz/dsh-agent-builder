/**
 * 运行时 ④ 评审接入：确定性三层过后才评审;不过则 steer 评审理由;
 * 评审通道出错同样消耗重试;预算耗尽诚实告警放行。
 */
import { describe, expect, it } from 'vitest'
import { type ReviewResult } from '@dsh-agent-builder/evaluator'
import { applyCore } from '../src/index.js'
import { makeHarness, writeGateFile } from './harness.js'

const GATE_WITH_REVIEW = `
version: 1
name: review-runtime
checks:
  - { id: amount_invalid, type: number, field: amount, exclusiveMin: 0 }
aiReview:
  - { id: note_sensible, criteria: 备注必须如实且不夸大 }
`

const SOURCE = '午餐 金额 428 元'
const GOOD_JSON = '```json\n{"amount": 428, "note": "午餐"}\n```'
const BAD_STRUCT_JSON = '```json\n{"amount": 0, "note": "午餐"}\n```'

function setup(results: ReviewResult[], maxRetries = 2) {
  const h = makeHarness()
  const calls: unknown[] = []
  applyCore(
    h.ctx as never,
    { gateFile: writeGateFile(GATE_WITH_REVIEW), maxRetries },
    async (input) => {
      calls.push(input)
      return results.shift() ?? { passed: true, findings: [] }
    },
  )
  return { ...h, calls }
}

const PASS: ReviewResult = { passed: true, findings: [{ id: 'note_sensible', passed: true, reason: 'ok' }] }
const FAIL: ReviewResult = { passed: false, findings: [{ id: 'note_sensible', passed: false, reason: '备注夸大' }] }
const ERR: ReviewResult = { passed: false, findings: [], error: '通道超时' }

describe('运行时 ④ 评审', () => {
  it('确定性过+评审过 → 放行,日志含④', async () => {
    const h = setup([PASS])
    h.emitUser(SOURCE)
    h.emitAssistant(GOOD_JSON)
    await h.stopTurn(1)
    expect(h.steers).toHaveLength(0)
    expect(h.calls).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('④评审'))).toBe(true)
  })

  it('确定性不过 → 不调评审(省一次 LLM),先修硬伤', async () => {
    const h = setup([PASS])
    h.emitUser(SOURCE)
    h.emitAssistant(BAD_STRUCT_JSON)
    await h.stopTurn(1)
    expect(h.calls).toHaveLength(0)
    expect(h.steers).toHaveLength(1)
  })

  it('评审不过 → steer 带标准与理由;改后复审通过', async () => {
    const h = setup([FAIL, PASS])
    h.emitUser(SOURCE)
    h.emitAssistant(GOOD_JSON)
    await h.stopTurn(1)
    expect(h.steers).toHaveLength(1)
    expect(h.steers[0]!.text).toContain('备注夸大')
    expect(h.steers[0]!.text).toContain('备注必须如实')
    h.emitAssistant(GOOD_JSON)
    await h.stopTurn(1)
    expect(h.steers).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('④评审'))).toBe(true)
  })

  it('评审通道出错 → 同样消耗重试,反馈说明不可用', async () => {
    const h = setup([ERR, PASS])
    h.emitUser(SOURCE)
    h.emitAssistant(GOOD_JSON)
    await h.stopTurn(1)
    expect(h.steers[0]!.text).toContain('暂时不可用')
    h.emitAssistant(GOOD_JSON)
    await h.stopTurn(1)
    expect(h.logs.some((l) => l.includes('④评审'))).toBe(true)
  })

  it('评审一直不过且预算耗尽 → 诚实告警放行,不死锁', async () => {
    const h = setup([FAIL, FAIL], 1)
    h.emitUser(SOURCE)
    h.emitAssistant(GOOD_JSON)
    await h.stopTurn(1) // 消耗唯一重试
    h.emitAssistant(GOOD_JSON)
    await h.stopTurn(1) // 预算耗尽
    expect(h.steers).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('仅确定性检查把关放行'))).toBe(true)
  })

  it('未注入评审器(如 reviewMode=off) → 只跑确定性,不拦', async () => {
    const h = makeHarness()
    applyCore(h.ctx as never, { gateFile: writeGateFile(GATE_WITH_REVIEW), maxRetries: 2 })
    h.emitUser(SOURCE)
    h.emitAssistant(GOOD_JSON)
    await h.stopTurn(1)
    expect(h.steers).toHaveLength(0)
    expect(h.logs.some((l) => l.includes('通过'))).toBe(true)
  })
})
