import { describe, expect, it } from 'vitest'
import { runGate } from '@dsh-agent-builder/gate-engine'
import { deriveGate, deriveGateYaml } from '../src/derive.js'
import { deriveWorkPrompt } from '../src/prompt.js'
import { derivePresetYaml } from '../src/preset.js'
import { validateSpec } from '../src/spec.js'
import { REIMBURSEMENT_SPEC, GOOD_SOURCE } from './fixtures.js'

const GOOD_RECORD = {
  item: '餐饮服务',
  amount: 428.0,
  tax: 24.23,
  date: '2026-08-12',
  'invoice-no': '24317000000123456789',
  category: '餐饮',
  note: '上海某餐饮',
}

describe('确定性推导', () => {
  it('规格合法', () => {
    expect(validateSpec(REIMBURSEMENT_SPEC)).toEqual([])
  })

  it('同一规格生成同一门禁（确定性）', () => {
    expect(deriveGateYaml(REIMBURSEMENT_SPEC)).toBe(deriveGateYaml(REIMBURSEMENT_SPEC))
  })

  it('生成的门禁能放行好记录', () => {
    const gate = deriveGate(REIMBURSEMENT_SPEC)
    const v = runGate(gate, { record: GOOD_RECORD, source: GOOD_SOURCE, today: '2026-08-18' })
    expect(v.issues).toEqual([])
    expect(v.passed).toBe(true)
    expect(v.pendingAiReview.map((a) => a.id)).toEqual(['category_sensible'])
  })

  it('生成的门禁能拦改数记录', () => {
    const gate = deriveGate(REIMBURSEMENT_SPEC)
    const v = runGate(gate, { record: { ...GOOD_RECORD, amount: 482.0 }, source: GOOD_SOURCE, today: '2026-08-18' })
    expect(v.passed).toBe(false)
    expect(v.issues.map((i) => i.code)).toContain('amount_not_grounded')
  })

  it('可空且不对照的字段（note）不生成 required/grounding 检查', () => {
    const yaml = deriveGateYaml(REIMBURSEMENT_SPEC)
    expect(yaml).not.toContain('note_empty')
    expect(yaml).not.toContain('note_not_grounded')
  })

  it('工作提示词包含任务与全部字段约定', () => {
    const p = deriveWorkPrompt(REIMBURSEMENT_SPEC)
    expect(p).toContain('报销单据整理助手')
    expect(p).toContain('json')
    for (const f of REIMBURSEMENT_SPEC.fields) expect(p).toContain(`"${f.name}"`)
    expect(p).toContain('绝不编造')
  })

  it('preset 指向插件与门禁文件', () => {
    const y = derivePresetYaml(REIMBURSEMENT_SPEC, {
      pluginPath: '/opt/gate/gate-plugin.mjs',
      gateFilePath: '/opt/gate/reimbursement.gate.yaml',
    })
    expect(y).toContain('gate-reimbursement')
    expect(y).toContain('/opt/gate/gate-plugin.mjs')
    expect(y).toContain('reimbursement.gate.yaml')
    expect(y).toContain('maxRetries: 2')
  })
})
