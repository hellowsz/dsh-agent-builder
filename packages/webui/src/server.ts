/**
 * 网页向导的 HTTP 服务:静态页 + 四个 JSON 接口。
 * 无框架、只绑本机;LLM 客户端与产物目录可注入,便于测试。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ChatClient, type ChatMessage } from '@dsh-agent-builder/evaluator'
import {
  deriveGate,
  draftSpec,
  freeze,
  generateSamples,
  runStability,
  validateSpec,
  type PipelineEvent,
  type Sample,
  type StabilityReport,
  type TaskSpec,
} from '@dsh-agent-builder/builder'
import { LogBus } from './logbus.js'
import { TaskStore } from './tasks.js'

const here = dirname(fileURLToPath(import.meta.url))
const MAX_BODY = 256 * 1024

export interface WebuiOptions {
  /** 工作 agent 的 LLM */
  readonly workClient: ChatClient
  /** ④ 独立评审的 LLM */
  readonly reviewClient: ChatClient
  /** 固化产物根目录(默认仓库根 agents/) */
  readonly outDir?: string
  /** gate-plugin 单文件产物路径(默认 packages/gate-plugin/dist) */
  readonly pluginPath?: string
  /** 任务持久化目录(默认仓库根 sessions/) */
  readonly sessionsDir?: string
}

interface Envelope {
  readonly ok: boolean
  readonly data?: unknown
  readonly error?: string
}

function send(res: ServerResponse, status: number, body: Envelope): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseSamples(raw: unknown, required: boolean): Sample[] {
  if (raw === undefined && !required) return []
  if (!Array.isArray(raw)) throw new Error('samples 必须是数组')
  const samples = raw
    .filter((s): s is { source?: unknown } => typeof s === 'object' && s !== null)
    .map((s, i) => ({
      name: `真实样例${i + 1}`,
      source: typeof s.source === 'string' ? s.source.trim() : '',
      expect: 'pass' as const,
    }))
    .filter((s) => s.source !== '')
  if (required && samples.length === 0) throw new Error('至少要一个非空样例')
  return samples
}

/** 校验请求里带来的 spec(系统边界:前端传回的数据不可信)。 */
function parseSpec(raw: unknown): TaskSpec {
  const spec = raw as TaskSpec
  const problems = validateSpec(spec)
  if (problems.length > 0) throw new Error(`规格不合法:${problems.join('；')}`)
  return spec
}

/** 包一层 LLM 客户端:每次调用记录耗时与体量。 */
function loggingClient(inner: ChatClient, role: string, bus: LogBus): ChatClient {
  return {
    async chat(messages: readonly ChatMessage[]) {
      const chars = messages.reduce((n, m) => n + m.content.length, 0)
      bus.log('info', 'llm', `${role} 调用开始(输入 ${chars} 字)`)
      const t0 = Date.now()
      try {
        const out = await inner.chat(messages)
        bus.log('ok', 'llm', `${role} 返回(${Date.now() - t0}ms,输出 ${out.length} 字)`)
        return out
      } catch (e) {
        bus.log('err', 'llm', `${role} 失败(${Date.now() - t0}ms):${e instanceof Error ? e.message : String(e)}`)
        throw e
      }
    },
  }
}

/** 流水线事件 → 日志条目。 */
function pipelineLog(bus: LogBus): (e: PipelineEvent) => void {
  return (e) => {
    switch (e.type) {
      case 'sample:start': bus.log('info', 'verify', `▶ ${e.sample} 开始`, e); break
      case 'work:done': bus.log('info', 'verify', `${e.sample} 工作 agent 产出(${e.ms}ms,${e.chars} 字)`, e); break
      case 'gate:verdict':
        bus.log(e.passed ? 'ok' : 'warn', 'gate', `${e.sample} 门禁${e.passed ? '通过' : `拦下:${e.issues.join('、')}`}`, e); break
      case 'review:done':
        bus.log(e.passed ? 'ok' : 'warn', 'review', `${e.sample} ④评审${e.passed ? '通过' : `未过:${e.error ?? e.issues.join('、')}`}(${e.ms}ms)`, e); break
      case 'sample:done':
        bus.log(e.ok ? 'ok' : 'err', 'verify', `■ ${e.sample} 结束:${e.actual}${e.ok ? '(符合预期)' : '(不符合预期)'}`, e); break
    }
  }
}

/** 建 HTTP 服务(不监听,由调用方 listen)。 */
export function createWebuiServer(options: WebuiOptions): Server {
  const outDir = options.outDir ?? resolve(here, '../../../agents')
  const pluginPath = options.pluginPath ?? resolve(here, '../../gate-plugin/dist/gate-plugin.mjs')
  const indexHtml = readFileSync(join(here, '../static/index.html'))
  const bus = new LogBus()
  const workClient = loggingClient(options.workClient, '工作agent', bus)
  const reviewClient = loggingClient(options.reviewClient, '评审agent', bus)
  const store = new TaskStore(options.sessionsDir ?? resolve(here, '../../../sessions'))
  bus.log('info', 'sys', `服务就绪(已加载 ${store.list().length} 个历史任务)`)

  return createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(indexHtml)
      return
    }
    if (req.method === 'GET' && url === '/api/events') {
      bus.subscribe(res)
      return
    }
    if (req.method === 'GET' && url === '/api/logs') {
      send(res, 200, { ok: true, data: { logs: bus.history() } })
      return
    }
    if (req.method === 'GET' && url === '/api/tasks') {
      send(res, 200, { ok: true, data: { tasks: store.list() } })
      return
    }
    if (req.method === 'GET' && url.startsWith('/api/task?id=')) {
      try {
        send(res, 200, { ok: true, data: { task: store.get(decodeURIComponent(url.slice('/api/task?id='.length))) } })
      } catch (e) {
        send(res, 404, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method !== 'POST' || !url.startsWith('/api/')) {
      send(res, 404, { ok: false, error: '不存在的路径' })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch (e) {
      send(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }

    try {
      switch (url) {
        case '/api/tasks': { // POST 新建任务
          const description = typeof body.description === 'string' ? body.description.trim() : ''
          if (description === '') throw new Error('请先用一句话描述你要什么')
          const task = store.create(description)
          bus.log('info', 'task', `新建任务:${task.title}`, { id: task.id })
          send(res, 200, { ok: true, data: { task } })
          return
        }
        case '/api/draft': {
          const task = store.get(typeof body.taskId === 'string' ? body.taskId : '')
          const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : ''
          const prompt = feedback === '' ? task.description : `${task.description}\n\n用户的修改意见：${feedback}`
          bus.log('info', 'draft', `[${task.title}] ${feedback === '' ? '起草拼接说明书' : '按意见修订说明书'}`)
          const spec = await draftSpec(workClient, prompt)
          const updated = store.update(task.id, { spec, title: spec.title, status: 'draft' })
          bus.log('ok', 'draft', `[${spec.title}] 说明书草案就绪(${spec.fields.length} 字段/${spec.rules.length} 规则/${spec.aiReview.length} 评审项)`, { spec })
          send(res, 200, { ok: true, data: { task: updated } })
          return
        }
        case '/api/explore': {
          const task = store.get(typeof body.taskId === 'string' ? body.taskId : '')
          if (task.spec === undefined) throw new Error('先起草并确认说明书')
          const spec = parseSpec(task.spec)
          const extra = parseSamples(body.samples, false)
          bus.log('info', 'explore', `[${task.title}] 样例自探索:AI 编造真实感样例(正例+无关反例)`)
          const generated = await generateSamples(workClient, spec, 2)
          const samples = [...generated, ...extra]
          bus.log('ok', 'explore',
            `[${task.title}] 样例就绪:${generated.length} 条自造${extra.length > 0 ? ` + ${extra.length} 条用户真实样例` : ''}`,
            { samples: samples.map((x) => ({ name: x.name, expect: x.expect, source: x.source })) })
          const gate = deriveGate(spec)
          bus.log('info', 'verify', `[${task.title}] 用 DeepSeek Harness 流水线拼装:${samples.length} 个样例,门禁 ${gate.checks.length} 项检查`)
          const report = await runStability(spec, gate, samples, {
            workClient,
            reviewClient,
            today: localToday(),
            onEvent: pipelineLog(bus),
          })
          bus.log(report.matchRate === 1 ? 'ok' : 'warn', 'verify',
            `[${task.title}] 拼装完成:${report.matched}/${report.total} 符合预期,等你评估产物`)
          const updated = store.update(task.id, { samples, report, status: 'review' })
          send(res, 200, { ok: true, data: { task: updated } })
          return
        }
        case '/api/freeze': {
          const task = store.get(typeof body.taskId === 'string' ? body.taskId : '')
          if (task.spec === undefined || task.report === undefined) throw new Error('先完成探索验证再定稿')
          const spec = parseSpec(task.spec)
          const result = freeze(spec, task.report, outDir, {
            pluginPath,
            gateFilePath: join(outDir, spec.name, `${spec.name}.gate.yaml`),
          })
          const dshCommand = `npx -y @deepseek-ai/dsh --patch ${result.dir}/${spec.name}.preset.yaml --profile web --port 3080`
          const frozen = { dir: result.dir, files: result.files, dshCommand }
          const updated = store.update(task.id, { frozen, status: 'frozen' })
          bus.log('ok', 'freeze', `[${task.title}] 拼接说明书已定稿:${result.dir}(${result.files.length} 个文件)`, { files: result.files })
          send(res, 200, { ok: true, data: { task: updated } })
          return
        }
        default:
          send(res, 404, { ok: false, error: '不存在的接口' })
      }
    } catch (e) {
      send(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
}
