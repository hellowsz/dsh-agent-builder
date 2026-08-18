/**
 * DSH 门禁插件（cordis 函数插件）。
 *
 * 职责：在 agent 即将收回合时（agent/turn-stopping）验收其最终产出——
 * 从最后一条 assistant 消息里抽出 JSON 结果，跑声明式门禁；
 * 不合格则 agent.steer() 喂回纠正指令重开回合（限次），合格放行。
 *
 * 每 agent 专属：把本插件放进该 agent 的 preset（ctx.agentPresets 作用域隔离），
 * 每份 preset 配自己的门禁文件。
 */
import { readFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseGate, runGate, type GateDefinition } from '@dsh-agent-builder/gate-engine'
import { extractJsonRecord } from './extract.js'
import { buildFeedback, NO_RECORD_FEEDBACK } from './feedback.js'

export const name = 'gate-plugin'

/** 插件配置。 */
export interface GatePluginConfig {
  /** 门禁文件（YAML）的绝对路径 */
  readonly gateFile: string
  /** 最大重试次数（steer 重开回合的上限），默认 2 */
  readonly maxRetries?: number
}

// ---- 面向 DSH 的最小结构类型（鸭子类型，便于单测注入替身） ----

interface TextBlock { readonly type: string; readonly text?: string }
interface MessageLike { readonly role?: string; readonly content: readonly TextBlock[]; readonly source?: { readonly kind?: string } }
interface SessionEventLike { readonly type: string; readonly data?: { readonly message?: MessageLike } }
interface SessionLike { readonly [k: string]: unknown }
interface AgentLike {
  readonly session: SessionLike
  steer(message: unknown): void
}
interface LoggerLike { info(...args: unknown[]): void; warn(...args: unknown[]): void }
interface ContextLike {
  on(event: 'session/event', cb: (session: SessionLike, event: SessionEventLike) => void): unknown
  on(event: 'agent/turn-stopping', cb: (payload: { agent: AgentLike; turn: number }) => void | Promise<void>): unknown
  logger?: LoggerLike
}

/** 每个会话跟踪的验收状态。 */
interface SessionState {
  /** 最近一条用户输入的文本（③ 对照的原文） */
  source?: string
  /** 最近一条 assistant 答复的文本 */
  lastAssistant?: string
  /** 各回合已用的重试次数 */
  retries: Map<number, number>
}

function textOf(message: MessageLike): string {
  return message.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 组一条 steer 消息（插件来源，notice 形态）。 */
function steerMessage(text: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary: '门禁拦截' },
  })
}

/** 校验配置并加载门禁文件。配置是系统边界，快速失败。 */
export function loadConfig(config: unknown): { gate: GateDefinition; maxRetries: number; gateFile: string } {
  if (typeof config !== 'object' || config === null) throw new Error('gate-plugin 需要配置对象')
  const c = config as Partial<GatePluginConfig>
  if (typeof c.gateFile !== 'string' || c.gateFile.trim() === '') throw new Error('gate-plugin 配置缺少 gateFile')
  const maxRetries = c.maxRetries ?? 2
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('gate-plugin 的 maxRetries 必须是非负整数')
  const gate = parseGate(readFileSync(c.gateFile, 'utf8'))
  return { gate, maxRetries, gateFile: c.gateFile }
}

/** cordis 入口。 */
export function apply(ctx: ContextLike, config: unknown): void {
  const { gate, maxRetries, gateFile } = loadConfig(config)
  const states = new WeakMap<SessionLike, SessionState>()
  const log = ctx.logger

  const stateOf = (session: SessionLike): SessionState => {
    const existing = states.get(session)
    if (existing !== undefined) return existing
    const fresh: SessionState = { retries: new Map() }
    states.set(session, fresh)
    return fresh
  }

  ctx.on('session/event', (session, event) => {
    if (event.data?.message === undefined) return
    const message = event.data.message
    if (event.type === 'user/message' && message.source?.kind === 'user') {
      stateOf(session).source = textOf(message)
    } else if (event.type === 'assistant/message') {
      stateOf(session).lastAssistant = textOf(message)
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = stateOf(agent.session)
    const answer = state.lastAssistant
    if (answer === undefined) return // 本回合没有 assistant 产出（如纯工具回合），不拦

    const used = state.retries.get(turn) ?? 0
    const record = extractJsonRecord(answer)

    if (record === undefined) {
      if (used >= maxRetries) {
        log?.warn(`[gate] ${gate.name}: 未产出结构化结果且重试用尽（turn ${turn}）`)
        return
      }
      state.retries.set(turn, used + 1)
      agent.steer(steerMessage(NO_RECORD_FEEDBACK))
      return
    }

    const verdict = runGate(gate, { record, source: state.source, today: localToday() })
    if (verdict.passed) {
      state.retries.delete(turn)
      log?.info(`[gate] ${gate.name}: 通过（turn ${turn}，检查 ${gate.checks.length} 项，门禁 ${gateFile}）`)
      return
    }
    if (used >= maxRetries) {
      log?.warn(`[gate] ${gate.name}: 重试用尽仍未通过（turn ${turn}）：${verdict.issues.map((i) => i.code).join(', ')}`)
      return
    }
    state.retries.set(turn, used + 1)
    agent.steer(steerMessage(buildFeedback(verdict, used + 1, maxRetries)))
  })
}
