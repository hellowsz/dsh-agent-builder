/**
 * 全流程（假 LLM）：起草规格 → 生成门禁 → 跑样例 → 报告 → 固化。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ChatClient } from '@dsh-agent-builder/evaluator'
import { draftSpec } from '../src/interview.js'
import { deriveGate } from '../src/derive.js'
import { runStability, renderReport } from '../src/stability.js'
import { freeze } from '../src/freeze.js'
import { GOOD_ANSWER, GOOD_SOURCE, REIMBURSEMENT_SPEC, TAMPERED_ANSWER } from './fixtures.js'

const APPROVE_REVIEW: ChatClient = {
  chat: async () => '{"findings":[{"id":"category_sensible","passed":true,"reason":"ok"}]}',
}

describe('draftSpec（假 LLM）', () => {
  it('一次给出合法 JSON 即通过', async () => {
    const client: ChatClient = { chat: async () => JSON.stringify(REIMBURSEMENT_SPEC) }
    const spec = await draftSpec(client, '帮我做个报销整理')
    expect(spec.name).toBe('reimbursement')
    expect(spec.fields.length).toBeGreaterThan(3)
  })

  it('第一稿不合法时把问题喂回去，第二稿通过', async () => {
    const answers = [
      '{"name":"Bad Name!","title":"","description":"","fields":[]}',
      JSON.stringify(REIMBURSEMENT_SPEC),
    ]
    const prompts: string[] = []
    const client: ChatClient = {
      chat: async (messages) => {
        prompts.push(messages.at(-1)!.content)
        return answers.shift()!
      },
    }
    const spec = await draftSpec(client, '帮我做个报销整理')
    expect(spec.name).toBe('reimbursement')
    expect(prompts[1]).toContain('kebab-case')
  })

  it('次数用尽仍不合法则抛错', async () => {
    const client: ChatClient = { chat: async () => '不是 JSON' }
    await expect(draftSpec(client, 'x', 2)).rejects.toThrow(/仍不合法/)
  })

  it('驼峰字段名被确定性归一为 kebab-case（真模型回归:模型爱输出 camelCase）', async () => {
    const camel = {
      ...REIMBURSEMENT_SPEC,
      name: 'ExpenseHelper',
      fields: [
        { name: 'expenseItem', label: '费用项目', kind: 'text' },
        { name: 'taxAmount', label: '税额', kind: 'number' },
        { name: 'invoice_no', label: '发票号', kind: 'text' },
      ],
      rules: [{ id: 'r1', type: 'compare', left: 'taxAmount', op: '<=', right: 'taxAmount' }],
      aiReview: [],
    }
    const client: ChatClient = { chat: async () => '```json\n' + JSON.stringify(camel) + '\n```' }
    const spec = await draftSpec(client, 'x')
    expect(spec.name).toBe('expense-helper')
    expect(spec.fields.map((f) => f.name)).toEqual(['expense-item', 'tax-amount', 'invoice-no'])
    expect(spec.rules[0]?.left).toBe('tax-amount')
  })
})

describe('稳定性验证 + 固化（假 LLM）', () => {
  it('好行为工作 agent：好样例 pass；改数工作 agent：被门禁拦下', async () => {
    const gate = deriveGate(REIMBURSEMENT_SPEC)
    let tamper = false
    const workClient: ChatClient = { chat: async () => (tamper ? TAMPERED_ANSWER : GOOD_ANSWER) }

    const good = await runStability(
      REIMBURSEMENT_SPEC, gate,
      [{ name: '真实发票', source: GOOD_SOURCE, expect: 'pass' }],
      { workClient, reviewClient: APPROVE_REVIEW, today: '2026-08-18' },
    )
    expect(good.matchRate).toBe(1)

    tamper = true
    const bad = await runStability(
      REIMBURSEMENT_SPEC, gate,
      [{ name: '改数注入', source: GOOD_SOURCE, expect: 'block' }],
      { workClient, reviewClient: APPROVE_REVIEW, today: '2026-08-18' },
    )
    expect(bad.matchRate).toBe(1)
    expect(bad.results[0]!.issues).toContain('amount_not_grounded')
  })

  it('④ 评审不过 → 拦下（review:<id> 记入问题）', async () => {
    const gate = deriveGate(REIMBURSEMENT_SPEC)
    const workClient: ChatClient = { chat: async () => GOOD_ANSWER }
    const rejectReview: ChatClient = {
      chat: async () => '{"findings":[{"id":"category_sensible","passed":false,"reason":"归类不符"}]}',
    }
    const r = await runStability(
      REIMBURSEMENT_SPEC, gate,
      [{ name: '评审拦截', source: GOOD_SOURCE, expect: 'block' }],
      { workClient, reviewClient: rejectReview, today: '2026-08-18' },
    )
    expect(r.results[0]!.actual).toBe('block')
    expect(r.results[0]!.issues).toContain('review:category_sensible')
  })

  it('固化落盘五件套', async () => {
    const gate = deriveGate(REIMBURSEMENT_SPEC)
    const workClient: ChatClient = { chat: async () => GOOD_ANSWER }
    const report = await runStability(
      REIMBURSEMENT_SPEC, gate,
      [{ name: 's1', source: GOOD_SOURCE, expect: 'pass' }],
      { workClient, reviewClient: APPROVE_REVIEW, today: '2026-08-18' },
    )
    const out = mkdtempSync(join(tmpdir(), 'freeze-'))
    const result = freeze(REIMBURSEMENT_SPEC, report, out, {
      pluginPath: '/opt/gate/gate-plugin.mjs',
      gateFilePath: join(out, 'reimbursement', 'reimbursement.gate.yaml'),
    })
    expect(result.files).toEqual([
      'reimbursement.gate.yaml',
      'reimbursement.prompt.md',
      'reimbursement.preset.yaml',
      'spec.json',
      'report.md',
    ])
    const md = readFileSync(join(result.dir, 'report.md'), 'utf8')
    expect(md).toContain('稳定性报告')
    expect(md).toContain('100%')
    expect(renderReport(REIMBURSEMENT_SPEC, report)).toBe(md)
  })
})
