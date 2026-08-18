/**
 * DeepSeek 真 API 集成测试。
 * 需要环境变量 DEEPSEEK_API_KEY；未设置时整组跳过（CI 不带密钥也能绿）。
 */
import { describe, expect, it } from 'vitest'
import { createDeepSeekClient, review } from '../src/index.js'

const apiKey = process.env.DEEPSEEK_API_KEY ?? ''

describe.skipIf(apiKey === '')('DeepSeek 真 API 评审', () => {
  const client = () => createDeepSeekClient({ apiKey })

  it('合理产出：评审通过', async () => {
    const r = await review(client(), {
      source: '上海老盛昌汤包馆 2026年8月12日 电子发票 金额 428.00 元 餐饮服务',
      record: { category: '餐饮', note: '上海老盛昌汤包馆' },
      items: [
        { id: 'category_sensible', criteria: '类别归类与费用项目、商户信息是否相符' },
        { id: 'note_sensible', criteria: '备注是否如实概括了商户/场景，没有编造信息' },
      ],
    })
    expect(r.error).toBeUndefined()
    expect(r.passed).toBe(true)
  }, 90_000)

  it('胡归类+编造备注：评审拦下', async () => {
    const r = await review(client(), {
      source: '上海老盛昌汤包馆 2026年8月12日 电子发票 金额 428.00 元 餐饮服务',
      record: { category: '住宿', note: '与客户在北京希尔顿酒店洽谈住宿费用' },
      items: [
        { id: 'category_sensible', criteria: '类别归类与费用项目、商户信息是否相符' },
        { id: 'note_sensible', criteria: '备注是否如实概括了商户/场景，没有编造信息' },
      ],
    })
    expect(r.error).toBeUndefined()
    expect(r.passed).toBe(false)
  }, 90_000)
})
