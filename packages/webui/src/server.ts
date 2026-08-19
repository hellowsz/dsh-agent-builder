/**
 * 网页向导的 HTTP 服务:静态页 + 四个 JSON 接口。
 * 无框架、只绑本机;LLM 客户端与产物目录可注入,便于测试。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ChatClient } from '@dsh-agent-builder/evaluator'
import {
  deriveGate,
  draftSpec,
  freeze,
  runStability,
  validateSpec,
  type Sample,
  type StabilityReport,
  type TaskSpec,
} from '@dsh-agent-builder/builder'

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

function parseSamples(raw: unknown): Sample[] {
  if (!Array.isArray(raw)) throw new Error('samples 必须是数组')
  const samples = raw
    .filter((s): s is { source?: unknown } => typeof s === 'object' && s !== null)
    .map((s, i) => ({
      name: `样例${i + 1}`,
      source: typeof s.source === 'string' ? s.source.trim() : '',
      expect: 'pass' as const,
    }))
    .filter((s) => s.source !== '')
  if (samples.length === 0) throw new Error('至少要一个非空样例')
  return samples
}

/** 校验请求里带来的 spec(系统边界:前端传回的数据不可信)。 */
function parseSpec(raw: unknown): TaskSpec {
  const spec = raw as TaskSpec
  const problems = validateSpec(spec)
  if (problems.length > 0) throw new Error(`规格不合法:${problems.join('；')}`)
  return spec
}

/** 建 HTTP 服务(不监听,由调用方 listen)。 */
export function createWebuiServer(options: WebuiOptions): Server {
  const outDir = options.outDir ?? resolve(here, '../../../agents')
  const pluginPath = options.pluginPath ?? resolve(here, '../../gate-plugin/dist/gate-plugin.mjs')
  const indexHtml = readFileSync(join(here, '../static/index.html'))

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
        case '/api/draft': {
          const description = typeof body.description === 'string' ? body.description.trim() : ''
          if (description === '') throw new Error('请先用一句话描述你要什么')
          const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : ''
          const prompt = feedback === '' ? description : `${description}\n\n用户的修改意见：${feedback}`
          const spec = await draftSpec(options.workClient, prompt)
          send(res, 200, { ok: true, data: { spec } })
          return
        }
        case '/api/verify': {
          const spec = parseSpec(body.spec)
          const samples = parseSamples(body.samples)
          const gate = deriveGate(spec)
          const report = await runStability(spec, gate, samples, {
            workClient: options.workClient,
            reviewClient: options.reviewClient,
            today: localToday(),
          })
          send(res, 200, { ok: true, data: { report } })
          return
        }
        case '/api/freeze': {
          const spec = parseSpec(body.spec)
          const report = body.report as StabilityReport
          if (typeof report !== 'object' || report === null || !Array.isArray(report.results)) {
            throw new Error('缺少稳定性报告,请先完成验证')
          }
          const result = freeze(spec, report, outDir, {
            pluginPath,
            gateFilePath: join(outDir, spec.name, `${spec.name}.gate.yaml`),
          })
          const dshCommand = `npx -y @deepseek-ai/dsh --patch ${result.dir}/${spec.name}.preset.yaml --profile web --port 3080`
          send(res, 200, { ok: true, data: { dir: result.dir, files: result.files, dshCommand } })
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
