import { describe, expect, it } from 'vitest'
import { type ChatClient } from '@dsh-agent-builder/evaluator'
import { generateSamples } from '../src/explore.js'
import { deriveGate } from '../src/derive.js'
import { runStability } from '../src/stability.js'
import { REIMBURSEMENT_SPEC } from './fixtures.js'

const GOOD_SET = '{"good":["北京饭店 2026年8月1日 发票 号码 111 金额 100.00 元 税额 5.66 餐饮","上海车行 2026年8月2日 发票 号码 222 金额 200.00 元 税额 11.32 交通"],"bad":["今天天气不错"]}'

describe('样例自探索', () => {
  it('生成 正例N + 反例1,期望标注正确', async () => {
    const client: ChatClient = { chat: async () => GOOD_SET }
    const samples = await generateSamples(client, REIMBURSEMENT_SPEC, 2)
    expect(samples).toHaveLength(3)
    expect(samples[0]).toMatchObject({ name: '探索样例1', expect: 'pass' })
    expect(samples[2]).toMatchObject({ name: '无关反例', expect: 'block' })
  })

  it('正例雷同 → 喂回重试,第二稿通过', async () => {
    const answers = ['{"good":["一样的","一样的"],"bad":["x"]}', GOOD_SET]
    const prompts: string[] = []
    const client: ChatClient = {
      chat: async (m) => { prompts.push(m.at(-1)!.content); return answers.shift()! },
    }
    const samples = await generateSamples(client, REIMBURSEMENT_SPEC, 2)
    expect(samples).toHaveLength(3)
    expect(prompts[1]).toContain('雷同')
  })

  it('次数用尽抛错', async () => {
    const client: ChatClient = { chat: async () => '没有json' }
    await expect(generateSamples(client, REIMBURSEMENT_SPEC, 2, 2)).rejects.toThrow(/仍未产出/)
  })

  it('探索样例跑完流水线,结果带最终产物(record)供用户确认', async () => {
    const workClient: ChatClient = {
      chat: async (m) => {
        const user = m.at(-1)!.content
        // 按样例原文回一个自洽 JSON(北京样例)
        if (user.includes('北京饭店')) {
          return '```json\n{"item":"餐饮","amount":100.0,"tax":5.66,"date":"2026-08-01","invoice-no":"111","category":"餐饮","note":""}\n```'
        }
        return '抽不到信息'
      },
    }
    const reviewClient: ChatClient = {
      chat: async () => '{"findings":[{"id":"category_sensible","passed":true,"reason":"ok"}]}',
    }
    const gate = deriveGate(REIMBURSEMENT_SPEC)
    const report = await runStability(
      REIMBURSEMENT_SPEC, gate,
      [
        { name: '探索样例1', source: '北京饭店 2026年8月1日 发票 号码 111 金额 100.00 元 税额 5.66 餐饮', expect: 'pass' },
        { name: '无关反例', source: '今天天气不错', expect: 'block' },
      ],
      { workClient, reviewClient, today: '2026-08-19' },
    )
    expect(report.matchRate).toBe(1)
    expect(report.results[0]!.record).toMatchObject({ amount: 100.0, 'invoice-no': '111' })
    expect(report.results[1]!.record).toBeUndefined()
  })
})
