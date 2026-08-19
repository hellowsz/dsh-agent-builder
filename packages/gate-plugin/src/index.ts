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
import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extractJsonRecord, parseGate, runGate, type GateDefinition } from '@dsh-agent-builder/gate-engine'
import { buildFeedback, buildReviewFeedback, NO_RECORD_FEEDBACK } from './feedback.js'
import { createReviewer, type ReviewChannelConfig, type Reviewer } from './review-runner.js'

export const name = 'gate-plugin'
export const inject = ['systemPrompt']
export { createReviewer, type Reviewer, type ReviewChannelConfig } from './review-runner.js'

/** 插件配置。 */
export interface GatePluginConfig extends ReviewChannelConfig {
  /** 门禁文件（YAML）的绝对路径 */
  readonly gateFile: string
  /** 最大重试次数（steer 重开回合的上限），默认 2 */
  readonly maxRetries?: number
  /** 工作提示词文件(md)的绝对路径:配置后注入为部署 persona,固化的 agent 一条命令即可用 */
  readonly promptFile?: string
  /** 运行期回流文件(jsonl):最终放行/拦截都记录,拦截带原文供说明书再版。配置即开(定稿资产默认开) */
  readonly feedbackFile?: string
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
interface SystemPromptLike {
  section(section: { readonly name: string; readonly order: number; readonly text: string }): unknown
}
interface ContextLike {
  on(event: 'session/event', cb: (session: SessionLike, event: SessionEventLike) => void): unknown
  on(event: 'agent/turn-stopping', cb: (payload: { agent: AgentLike; turn: number }) => void | Promise<void>): unknown
  logger?: LoggerLike
  systemPrompt?: SystemPromptLike
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

/**
 * 组一条 steer 消息（插件来源，notice 形态）。
 * 与 DSH 的 createUserMessage 同构（randomUUID 身份 + 冻结），自实现以保持打包产物完全自包含——
 * 打包内联 @deepseek-ai/dsh-llm 会因其运行时 require('../package.json') 在独立文件里崩。
 */
function steerMessage(text: string): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: name, form: 'notice', summary: '门禁拦截' }),
  })
}

/** 校验配置并加载门禁文件。配置是系统边界，快速失败。 */
export function loadConfig(config: unknown): { gate: GateDefinition; maxRetries: number; gateFile: string; promptText?: string } {
  if (typeof config !== 'object' || config === null) throw new Error('gate-plugin 需要配置对象')
  const c = config as Partial<GatePluginConfig>
  if (typeof c.gateFile !== 'string' || c.gateFile.trim() === '') throw new Error('gate-plugin 配置缺少 gateFile')
  const maxRetries = c.maxRetries ?? 2
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('gate-plugin 的 maxRetries 必须是非负整数')
  const gate = parseGate(readFileSync(c.gateFile, 'utf8'))
  const promptText = typeof c.promptFile === 'string' && c.promptFile.trim() !== ''
    ? readFileSync(c.promptFile, 'utf8')
    : undefined
  const feedbackFile = typeof c.feedbackFile === 'string' && c.feedbackFile.trim() !== '' ? c.feedbackFile : undefined
  return { gate, maxRetries, gateFile: c.gateFile, promptText, feedbackFile }
}

/** cordis 入口：按配置建评审通道（门禁没有 aiReview 条目则不建）。 */
export function apply(ctx: ContextLike, config: unknown): void {
  const loaded = loadConfig(config)
  const reviewer =
    (loaded.gate.aiReview?.length ?? 0) > 0 ? createReviewer(config as ReviewChannelConfig) : undefined
  applyCore(ctx, config, reviewer)
}

/** 核心装配（评审执行器可注入，便于单测）。 */
export function applyCore(ctx: ContextLike, config: unknown, reviewer?: Reviewer): void {
  const { gate, maxRetries, gateFile, promptText, feedbackFile } = loadConfig(config)

  /** 运行期回流:一行一条,写失败绝不影响主流程。 */
  const feedback = (entry: Record<string, unknown>): void => {
    if (feedbackFile === undefined) return
    try {
      appendFileSync(feedbackFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
    } catch {
      ctx.logger?.warn(`[gate] ${gate.name}: 回流写入失败(${feedbackFile})`)
    }
  }

  // 注入工作提示词为部署 persona(order 0),固化的 agent 免手动贴提示词
  if (promptText !== undefined) {
    if (ctx.systemPrompt !== undefined) {
      ctx.systemPrompt.section({ name: `gate-agent-prompt:${gate.name}`, order: 0, text: promptText })
    } else {
      ctx.logger?.warn(`[gate] ${gate.name}: 配置了 promptFile 但运行环境没有 systemPrompt 服务,提示词未注入`)
    }
  }
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

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const state = stateOf(agent.session)
    const answer = state.lastAssistant
    if (answer === undefined) return // 本回合没有 assistant 产出（如纯工具回合），不拦

    const used = state.retries.get(turn) ?? 0
    const record = extractJsonRecord(answer)

    if (record === undefined) {
      if (used >= maxRetries) {
        log?.warn(`[gate] ${gate.name}: 未产出结构化结果且重试用尽（turn ${turn}）`)
        feedback({ kind: 'block', source: state.source ?? '', issues: ['no_structured_output'] })
        return
      }
      state.retries.set(turn, used + 1)
      agent.steer(steerMessage(NO_RECORD_FEEDBACK))
      return
    }

    const verdict = runGate(gate, { record, source: state.source, today: localToday() })
    if (!verdict.passed) {
      if (used >= maxRetries) {
        log?.warn(`[gate] ${gate.name}: 重试用尽仍未通过（turn ${turn}）：${verdict.issues.map((i) => i.code).join(', ')}`)
        feedback({ kind: 'block', source: state.source ?? '', record, issues: verdict.issues.map((i) => i.code) })
        return
      }
      state.retries.set(turn, used + 1)
      agent.steer(steerMessage(buildFeedback(verdict, used + 1, maxRetries)))
      return
    }

    // 确定性三层全过 → ④ 独立评审（若门禁声明了且通道未关）
    if (reviewer !== undefined && verdict.pendingAiReview.length > 0) {
      const result = await reviewer({
        source: state.source ?? '',
        record,
        items: verdict.pendingAiReview,
      })
      if (!result.passed) {
        if (used >= maxRetries) {
          // 重试预算耗尽:诚实告警放行(运行时无限扣住回合会让 agent 卡死,比错误更伤)
          const why = result.error ?? result.findings.filter((f) => !f.passed).map((f) => f.id).join(', ')
          log?.warn(`[gate] ${gate.name}: ④评审未过且重试用尽,仅确定性检查把关放行（turn ${turn}）：${why}`)
          feedback({ kind: 'block', source: state.source ?? '', record, issues: [`review:${why}`] })
          state.retries.delete(turn)
          return
        }
        state.retries.set(turn, used + 1)
        agent.steer(steerMessage(buildReviewFeedback(result, verdict.pendingAiReview, used + 1, maxRetries)))
        return
      }
    }

    state.retries.delete(turn)
    feedback({ kind: 'pass' })
    const reviewNote = reviewer !== undefined && verdict.pendingAiReview.length > 0 ? '+④评审' : ''
    log?.info(`[gate] ${gate.name}: 通过（turn ${turn}，检查 ${gate.checks.length} 项${reviewNote}，门禁 ${gateFile}）`)
  })
}
