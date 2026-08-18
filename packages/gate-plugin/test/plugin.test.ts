import { describe, expect, it } from 'vitest'
import { apply, loadConfig } from '../src/index.js'
import { extractJsonRecord } from '../src/extract.js'
import { makeHarness, writeGateFile, TEST_GATE_YAML } from './harness.js'

const SOURCE = '发票 号码 INV20260812 金额 428.00 元'
const GOOD_JSON = '```json\n{"amount": 428.0, "invoiceNo": "INV20260812"}\n```'
const TAMPERED_JSON = '```json\n{"amount": 482.0, "invoiceNo": "INV20260812"}\n```'

function setup(maxRetries = 2) {
  const h = makeHarness()
  apply(h.ctx as never, { gateFile: writeGateFile(TEST_GATE_YAML), maxRetries })
  return h
}

describe('extractJsonRecord', () => {
  it('抽最后一个 json 围栏', () => {
    expect(extractJsonRecord('说明\n```json\n{"a":1}\n```\n再说\n```json\n{"a":2}\n```')).toEqual({ a: 2 })
  })
  it('整段裸 JSON 也接受', () => {
    expect(extractJsonRecord('{"a":1}')).toEqual({ a: 1 })
  })
  it('没有 JSON 返回 undefined', () => {
    expect(extractJsonRecord('只有文字')).toBeUndefined()
  })
  it('数组不算记录', () => {
    expect(extractJsonRecord('[1,2]')).toBeUndefined()
  })
})

describe('loadConfig：配置边界', () => {
  it('缺 gateFile 快速失败', () => {
    expect(() => loadConfig({})).toThrow(/gateFile/)
  })
  it('非法 maxRetries 快速失败', () => {
    expect(() => loadConfig({ gateFile: writeGateFile(TEST_GATE_YAML), maxRetries: -1 })).toThrow(/maxRetries/)
  })
  it('门禁文件不合法快速失败', () => {
    expect(() => loadConfig({ gateFile: writeGateFile('version: 9') })).toThrow(/门禁文件不合法/)
  })
})

describe('运行时拦截流', () => {
  it('合格产出：放行，不 steer', () => {
    const h = setup()
    h.emitUser(SOURCE)
    h.emitAssistant(`填好了：\n${GOOD_JSON}`)
    h.stopTurn(1)
    expect(h.steers).toHaveLength(0)
    expect(h.logs.some((l) => l.includes('通过'))).toBe(true)
  })

  it('改数产出：steer 纠正指令，且指出具体问题', () => {
    const h = setup()
    h.emitUser(SOURCE)
    h.emitAssistant(TAMPERED_JSON)
    h.stopTurn(1)
    expect(h.steers).toHaveLength(1)
    expect(h.steers[0]!.text).toContain('amount')
    expect(h.steers[0]!.text).toContain('找不到依据')
  })

  it('重试后改对：第二次放行', () => {
    const h = setup()
    h.emitUser(SOURCE)
    h.emitAssistant(TAMPERED_JSON)
    h.stopTurn(1)
    h.emitAssistant(GOOD_JSON) // agent 改对了
    h.stopTurn(1)
    expect(h.steers).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('通过'))).toBe(true)
  })

  it('重试用尽：不再 steer，记录警告（防死循环）', () => {
    const h = setup(1)
    h.emitUser(SOURCE)
    h.emitAssistant(TAMPERED_JSON)
    h.stopTurn(1) // 第 1 次拦截，用掉唯一重试
    h.emitAssistant(TAMPERED_JSON)
    h.stopTurn(1) // 重试用尽
    h.emitAssistant(TAMPERED_JSON)
    h.stopTurn(1) // 不应再 steer
    expect(h.steers).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('重试用尽'))).toBe(true)
  })

  it('没有结构化产出：steer 要求补 JSON', () => {
    const h = setup()
    h.emitUser(SOURCE)
    h.emitAssistant('我整理好了,请查收。')
    h.stopTurn(1)
    expect(h.steers).toHaveLength(1)
    expect(h.steers[0]!.text).toContain('json')
  })

  it('纯工具回合（无 assistant 产出）：不拦', () => {
    const h = setup()
    h.stopTurn(1)
    expect(h.steers).toHaveLength(0)
  })

  it('新回合重置重试预算', () => {
    const h = setup(1)
    h.emitUser(SOURCE)
    h.emitAssistant(TAMPERED_JSON)
    h.stopTurn(1)
    expect(h.steers).toHaveLength(1)
    h.emitAssistant(TAMPERED_JSON)
    h.stopTurn(2) // 新回合，重试预算独立
    expect(h.steers).toHaveLength(2)
  })
})
