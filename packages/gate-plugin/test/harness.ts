/**
 * 单测替身：模拟 DSH 的事件派发与 agent，驱动插件走完整验收流。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (...args: unknown[]) => unknown

export interface SteerCall { readonly text: string }

/** 造一个最小 ctx 替身，记录事件监听并可回放。 */
export function makeHarness() {
  const handlers = new Map<string, Handler>()
  const logs: string[] = []
  const ctx = {
    on(event: string, cb: Handler) {
      handlers.set(event, cb)
      return () => handlers.delete(event)
    },
    logger: {
      info: (...a: unknown[]) => logs.push(`info:${a.join(' ')}`),
      warn: (...a: unknown[]) => logs.push(`warn:${a.join(' ')}`),
    },
  }

  const session = {}
  const steers: SteerCall[] = []
  const agent = {
    session,
    steer(message: unknown) {
      const m = message as { content: Array<{ text?: string }> }
      steers.push({ text: m.content[0]?.text ?? '' })
    },
  }

  const emitUser = (text: string) =>
    handlers.get('session/event')!(session, {
      type: 'user/message',
      data: { message: { content: [{ type: 'text', text }], source: { kind: 'user' } } },
    })

  const emitAssistant = (text: string) =>
    handlers.get('session/event')!(session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    })

  const stopTurn = async (turn: number) => await handlers.get('agent/turn-stopping')!({ agent, turn })

  return { ctx, agent, steers, logs, emitUser, emitAssistant, stopTurn }
}

/** 把门禁 YAML 写进临时文件，返回路径。 */
export function writeGateFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'))
  const p = join(dir, 'test.gate.yaml')
  writeFileSync(p, yaml)
  return p
}

/** 测试用门禁：模拟报销核心检查的精简版。 */
export const TEST_GATE_YAML = `
version: 1
name: test-reimbursement
checks:
  - { id: amount_not_positive, type: number, field: amount, exclusiveMin: 0 }
  - { id: invoice_empty, type: required, field: invoiceNo }
  - { id: amount_not_grounded, type: number-grounded, field: amount }
  - { id: invoice_not_grounded, type: text-grounded, field: invoiceNo }
`
