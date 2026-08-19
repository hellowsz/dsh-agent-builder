/**
 * 网页向导的 HTTP 服务:静态页 + 四个 JSON 接口。
 * 无框架、只绑本机;LLM 客户端与产物目录可注入,便于测试。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ChatClient, type ChatMessage } from '@dsh-agent-builder/evaluator'
import { fingerprintText } from '@dsh-agent-builder/gate-engine'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  collectWebMaterials,
  createDshProducer,
  deriveGate,
  draftSpec,
  freeze,
  generateSamples,
  mergeSampleBank,
  readRuntimeBlocks,
  readRuntimeEvidence,
  runStability,
  tierOf,
  TIER_LABEL,
  validateSpec,
  writeCandidate,
  readCatalog,
  relevantPlugins,
  pluginsHint,
  type PipelineEvent,
  type ProducedOutput,
  type Sample,
  type StabilityReport,
  type TaskSpec,
  TaskStore,
} from '@dsh-agent-builder/builder'
import { LogBus } from './logbus.js'


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
  /**
   * 产物生产工厂(可注入,测试用):给定候选 preset 文件,返回"样例→产物"函数。
   * 缺省 createDshProducer——拼装发生在真 DeepSeek Harness 里。
   */
  readonly produceFactory?: (presetFile: string, runsDir?: string) => (sample: Sample) => Promise<string | ProducedOutput>
  /** 一键启动器(可注入,测试用):给定 preset 返回可访问的 URL。缺省真启 dsh web。 */
  readonly launcher?: (presetFile: string) => Promise<string>
  /** 网络素材采集器(可注入,测试用):缺省 collectWebMaterials(真上网,默认开)。 */
  readonly materialsCollector?: (spec: TaskSpec) => Promise<Sample[]>
  /** 插件生态清单文件路径(每日收集产出);设置后设计时喂相关插件给 AI + /api/plugins 可查 */
  readonly catalogPath?: string
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
  const landingHtml = readFileSync(join(here, '../static/landing.html'))
  const bus = new LogBus()
  const workClient = loggingClient(options.workClient, '工作agent', bus)
  const reviewClient = loggingClient(options.reviewClient, '评审agent', bus)
  const sessionsDir = options.sessionsDir ?? resolve(here, '../../../sessions')
  const store = new TaskStore(sessionsDir)
  const produceFactory = options.produceFactory ?? ((presetFile: string, runsDir?: string) =>
    createDshProducer({ presetFile, ...(runsDir !== undefined ? { runsDir } : {}) }))
  const materialsCollector = options.materialsCollector ?? ((spec: TaskSpec) => collectWebMaterials(workClient, spec, 1))
  let dshChild: ReturnType<typeof spawn> | undefined
  let runningPreset: string | undefined
  const DSH_URL = 'http://127.0.0.1:3080'
  const dshAlive = async (): Promise<boolean> => {
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 1500)
      const r = await fetch(DSH_URL, { signal: controller.signal })
      clearTimeout(t)
      return r.ok
    } catch {
      return false
    }
  }
  const launcher = options.launcher ?? (async (presetFile: string) => {
    // 同一资产已在跑 → 秒回,直接复用
    if (runningPreset === presetFile && await dshAlive()) return DSH_URL
    dshChild?.kill()
    runningPreset = undefined
    dshChild = spawn('npx', ['-y', '@deepseek-ai/dsh', '--patch', presetFile, '--profile', 'web', '--port', '3080'], {
      detached: false, stdio: 'ignore',
    })
    // 轮询到 DSH 真就绪才返回,保证用户点开就是能用的页面
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      if (await dshAlive()) {
        runningPreset = presetFile
        return DSH_URL
      }
    }
    throw new Error('DSH 启动超时(90 秒),请查看终端确认 dsh 是否可用')
  })
  const catalogPath = options.catalogPath
  bus.log('info', 'sys', `服务就绪(已加载 ${store.list().length} 个历史任务${catalogPath !== undefined ? `,插件生态清单 ${readCatalog(catalogPath).length} 条` : ''})`)

  return createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(landingHtml)
      return
    }
    if (req.method === 'GET' && (url === '/app' || url === '/app.html')) {
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
    if (req.method === 'GET' && url.startsWith('/api/plugins')) {
      const all = catalogPath !== undefined ? readCatalog(catalogPath) : []
      const params = new URL(url, 'http://x').searchParams
      const q = params.get('q') ?? ''
      const list = q !== '' ? relevantPlugins(all, q, 20) : all.slice(0, 50)
      send(res, 200, { ok: true, data: { total: all.length, plugins: list } })
      return
    }
    if (req.method === 'GET' && url === '/api/tasks') {
      send(res, 200, { ok: true, data: { tasks: store.list() } })
      return
    }
    if (req.method === 'GET' && url.startsWith('/api/run-file?')) {
      const params = new URL(url, 'http://x').searchParams
      const taskId = params.get('taskId') ?? ''
      const file = params.get('file') ?? ''
      const base = resolve(sessionsDir, taskId, 'runs')
      const full = resolve(base, file)
      if (taskId === '' || file === '' || !full.startsWith(base + '/') || !existsSync(full)) {
        send(res, 404, { ok: false, error: '文件不存在' })
        return
      }
      const ext = full.slice(full.lastIndexOf('.') + 1).toLowerCase()
      const types: Record<string, string> = {
        pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
        json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8',
      }
      res.writeHead(200, {
        'content-type': types[ext] ?? 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(full.slice(full.lastIndexOf('/') + 1))}`,
      })
      res.end(readFileSync(full))
      return
    }
    if (req.method === 'GET' && url === '/api/assets') {
      const assets = existsSync(outDir)
        ? readdirSync(outDir).flatMap((name) => {
            const specFile = join(outDir, name, 'spec.json')
            const presetFile = join(outDir, name, `${name}.preset.yaml`)
            if (!existsSync(specFile) || !existsSync(presetFile)) return []
            const spec = JSON.parse(readFileSync(specFile, 'utf8')) as TaskSpec
            const metaFile = join(outDir, name, 'meta.json')
            const meta = existsSync(metaFile)
              ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { tier?: string })
              : {}
            const evidence = readRuntimeEvidence(join(outDir, name, 'runtime-feedback.jsonl'))
            const gateFileP = join(outDir, name, `${name}.gate.yaml`)
            const promptFileP = join(outDir, name, `${name}.prompt.md`)
            const fingerprint = fingerprintText(
              readFileSync(gateFileP, 'utf8'),
              existsSync(promptFileP) ? readFileSync(promptFileP, 'utf8') : '',
            )
            // 线上零拦截连击达标 → silver 升 gold
            const tier = meta.tier === 'silver' && evidence.cleanStreak >= 10 ? 'gold' : (meta.tier ?? 'bronze')
            return [{
              name,
              title: spec.title,
              frozenAt: statSync(specFile).mtime.toISOString(),
              presetFile,
              tier,
              fingerprint,
              tierLabel: TIER_LABEL[tier as keyof typeof TIER_LABEL] ?? tier,
              runtimeBlocked: evidence.blockedTotal,
              runtimeCleanStreak: evidence.cleanStreak,
              dshCommand: `npx -y @deepseek-ai/dsh --patch ${presetFile} --profile web --port 3080`,
            }]
          })
        : []
      send(res, 200, { ok: true, data: { assets } })
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
          let hint = ''
          if (catalogPath !== undefined) {
            const rel = relevantPlugins(readCatalog(catalogPath), task.description, 5)
            if (rel.length > 0) { hint = pluginsHint(rel); bus.log('info', 'draft', `[${task.title}] 生态里挑到 ${rel.length} 个可能相关插件供设计参考:${rel.map((r) => r.name).join(', ')}`) }
          }
          const spec = await draftSpec(workClient, prompt, 3, hint)
          const updated = store.update(task.id, { spec, title: spec.title, status: 'draft' })
          bus.log('ok', 'draft', `[${spec.title}] 说明书草案就绪(${spec.fields.length} 字段/${spec.rules.length} 规则/${spec.aiReview.length} 评审项)`, { spec })
          send(res, 200, { ok: true, data: { task: updated } })
          return
        }
        case '/api/explore': {
          const task = store.get(typeof body.taskId === 'string' ? body.taskId : '')
          if (task.spec === undefined) throw new Error('先起草并确认说明书')
          const spec = parseSpec(task.spec)
          const extra = parseSamples(body.samples, false).map((x) => ({ ...x, origin: 'real' as const }))
          const bankBefore = task.samples ?? []
          const incoming: Sample[] = [...extra]
          if (bankBefore.length === 0) {
            bus.log('info', 'explore', `[${task.title}] 样例自探索:AI 编造真实感样例(正例+无关反例)`)
            incoming.push(...await generateSamples(workClient, spec, 2))
          }
          // 网络素材(默认开):还没有 web 级证据时上网采集,失败降级并如实记录
          if (![...bankBefore, ...incoming].some((x) => x.origin === 'web')) {
            bus.log('info', 'explore', `[${task.title}] 上网采集真实素材…`)
            const webSamples = await materialsCollector(spec)
            if (webSamples.length > 0) bus.log('ok', 'explore', `[${task.title}] 网络素材 ${webSamples.length} 条入集`)
            else bus.log('warn', 'explore', `[${task.title}] 网络素材采集失败,本轮以合成样例为主(信心上限 🥉)`)
            incoming.push(...webSamples)
          }
          // 定稿资产的线上翻车样本自动回流(默认开)
          if (task.frozen !== undefined) {
            const blocks = readRuntimeBlocks(join(task.frozen.dir, 'runtime-feedback.jsonl'))
            if (blocks.length > 0) bus.log('info', 'explore', `[${task.title}] 回流 ${blocks.length} 条线上翻车样本进回归集`)
            incoming.push(...blocks)
          }
          const samples = mergeSampleBank(bankBefore, incoming)
          bus.log('ok', 'explore',
            `[${task.title}] 回归样例集:${samples.length} 条(历史 ${bankBefore.length} + 新增 ${samples.length - bankBefore.length}),全量重跑`,
            { samples: samples.map((x) => ({ name: x.name, expect: x.expect, origin: x.origin ?? 'synthetic', source: x.source })) })
          const gate = deriveGate(spec)
          const candidate = writeCandidate(spec, join(sessionsDir, task.id, 'candidate'), { pluginPath })
          bus.log('info', 'exec', `[${task.title}] 设计完成→候选配置已写盘,交给 DeepSeek Harness 执行(${samples.length} 个样例,门禁 ${gate.checks.length} 项)`, { candidate })
          const report = await runStability(spec, gate, samples, {
            workClient,
            reviewClient,
            today: localToday(),
            onEvent: pipelineLog(bus),
            produce: produceFactory(candidate.presetFile, join(sessionsDir, task.id, 'runs')),
          })
          const tier = tierOf(samples, report)
          bus.log(report.matchRate === 1 ? 'ok' : 'warn', 'verify',
            `[${task.title}] DSH 拼装完成,agent builder 评审毕:${report.matched}/${report.total} 符合预期,信心等级:${TIER_LABEL[tier]}`)
          const updated = store.update(task.id, { samples, report, tier, status: 'review' })
          send(res, 200, { ok: true, data: { task: updated } })
          return
        }
        case '/api/assets/launch': {
          const name = typeof body.name === 'string' ? body.name : ''
          const presetFile = join(outDir, name, `${name}.preset.yaml`)
          if (name === '' || !existsSync(presetFile)) throw new Error(`资产不存在:${name}`)
          bus.log('info', 'assets', `一键启动:${name} 挂载进 DeepSeek Harness…`)
          const launchedUrl = await launcher(presetFile)
          bus.log('ok', 'assets', `${name} 已就绪:${launchedUrl}(直接贴原文使用,四层门禁在岗)`)
          send(res, 200, { ok: true, data: { url: launchedUrl } })
          return
        }
        case '/api/freeze': {
          const task = store.get(typeof body.taskId === 'string' ? body.taskId : '')
          if (task.spec === undefined || task.report === undefined) throw new Error('先完成探索验证再定稿')
          const spec = parseSpec(task.spec)
          const result = freeze(spec, task.report, outDir, {
            pluginPath,
            gateFilePath: join(outDir, spec.name, `${spec.name}.gate.yaml`),
          }, task.samples)
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
