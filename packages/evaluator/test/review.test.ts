import { describe, expect, it } from 'vitest'
import { review, type ChatClient } from '../src/index.js'

const ITEMS = [
  { id: 'category_sensible', criteria: '类别归类是否合理' },
  { id: 'note_sensible', criteria: '备注是否如实' },
] as const

const INPUT = {
  source: '上海某餐饮 金额 428 元 餐饮服务',
  record: { category: '餐饮', note: '上海某餐饮' },
  items: ITEMS,
}

function fake(answer: string): ChatClient {
  return { chat: async () => answer }
}

describe('④ 独立评审', () => {
  it('全部通过', async () => {
    const r = await review(
      fake('{"findings":[{"id":"category_sensible","passed":true,"reason":"ok"},{"id":"note_sensible","passed":true,"reason":"ok"}]}'),
      INPUT,
    )
    expect(r.passed).toBe(true)
    expect(r.findings).toHaveLength(2)
  })

  it('任一不过则整体不过，并保留理由', async () => {
    const r = await review(
      fake('{"findings":[{"id":"category_sensible","passed":false,"reason":"类别与商户不符"},{"id":"note_sensible","passed":true,"reason":"ok"}]}'),
      INPUT,
    )
    expect(r.passed).toBe(false)
    expect(r.findings.find((f) => f.id === 'category_sensible')?.reason).toContain('不符')
  })

  it('评审输出缺某条标准的结论 → 评审失败，不静默放行', async () => {
    const r = await review(
      fake('{"findings":[{"id":"category_sensible","passed":true,"reason":"ok"}]}'),
      INPUT,
    )
    expect(r.passed).toBe(false)
    expect(r.error).toContain('note_sensible')
  })

  it('评审输出不是 JSON → 评审失败', async () => {
    const r = await review(fake('我觉得都挺好'), INPUT)
    expect(r.passed).toBe(false)
    expect(r.error).toBeDefined()
  })

  it('网络异常 → 评审失败，错误透出', async () => {
    const boom: ChatClient = { chat: async () => { throw new Error('接口超时') } }
    const r = await review(boom, INPUT)
    expect(r.passed).toBe(false)
    expect(r.error).toBe('接口超时')
  })

  it('无 ④ 条目 → 直接通过，不调 LLM', async () => {
    const neverCall: ChatClient = { chat: async () => { throw new Error('不应被调用') } }
    const r = await review(neverCall, { ...INPUT, items: [] })
    expect(r.passed).toBe(true)
  })

  it('无关/未知 id 的结论被忽略', async () => {
    const r = await review(
      fake('{"findings":[{"id":"hacker","passed":true},{"id":"category_sensible","passed":true,"reason":"ok"},{"id":"note_sensible","passed":true,"reason":"ok"}]}'),
      INPUT,
    )
    expect(r.passed).toBe(true)
    expect(r.findings.map((f) => f.id)).toEqual(['category_sensible', 'note_sensible'])
  })
})
