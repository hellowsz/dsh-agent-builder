import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ChatClient } from '@dsh-agent-builder/evaluator'
import { createWebuiServer } from '../src/server.js'

const SPEC = {
  name: 'demo-sorter',
  title: '演示整理助手',
  description: '把原文整理成结构化结果',
  fields: [
    { name: 'amount', label: '金额', kind: 'number' },
    { name: 'note', label: '备注', kind: 'text', optional: true, grounded: false },
  ],
  rules: [],
  aiReview: [{ id: 'note_ok', criteria: '备注如实' }],
}

// 假工作 agent:起草时回规格;干活时回抽取结果
const workClient: ChatClient = {
  chat: async (messages) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    if (system.includes('任务规格')) return JSON.stringify(SPEC)
    if (system.includes('测试样例设计师')) {
      return '{"good":["午餐 金额 428 元","打车 金额 56 元"],"bad":["今天天气不错"]}'
    }
    const user = messages.at(-1)?.content ?? ''
    if (user.includes('天气')) return '这段文字里没有可整理的信息。'
    if (user.includes('56')) return '```json\n{"amount": 56, "note": "打车"}\n```'
    return '```json\n{"amount": 428, "note": "午餐"}\n```'
  },
}
const reviewClient: ChatClient = {
  chat: async () => '{"findings":[{"id":"note_ok","passed":true,"reason":"ok"}]}',
}

const outDir = mkdtempSync(join(tmpdir(), 'webui-out-'))
const server = createWebuiServer({ workClient, reviewClient, outDir, pluginPath: '/tmp/fake-plugin.mjs' })
let base = ''

beforeAll(async () => {
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: never; error?: string } }
}

describe('webui 服务', () => {
  it('GET / 返回向导页', async () => {
    const res = await fetch(base + '/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('dsh-agent-builder')
    expect(html).toContain('PIPELINE')
    expect(html).toContain('CONSOLE')
    expect(html).toContain('/api/events')
  })

  it('draft:描述 → 规格', async () => {
    const r = await post('/api/draft', { description: '帮我整理' })
    expect(r.status).toBe(200)
    expect((r.body.data as { spec: { name: string } }).spec.name).toBe('demo-sorter')
  })

  it('draft:空描述 400', async () => {
    const r = await post('/api/draft', { description: ' ' })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('描述')
  })

  it('verify:规格+样例 → 报告(含④评审)', async () => {
    const r = await post('/api/verify', { spec: SPEC, samples: [{ source: '午餐 金额 428 元' }] })
    expect(r.status).toBe(200)
    const report = (r.body.data as { report: { matchRate: number } }).report
    expect(report.matchRate).toBe(1)
  })

  it('verify:非法规格 400(前端数据不可信)', async () => {
    const r = await post('/api/verify', { spec: { ...SPEC, name: 'Bad Name' }, samples: [{ source: 'x' }] })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('规格不合法')
  })

  it('verify:空样例 400', async () => {
    const r = await post('/api/verify', { spec: SPEC, samples: [] })
    expect(r.status).toBe(400)
  })

  it('freeze:落盘五件套并给出 dsh 命令', async () => {
    const v = await post('/api/verify', { spec: SPEC, samples: [{ source: '午餐 金额 428 元' }] })
    const report = (v.body.data as { report: unknown }).report
    const r = await post('/api/freeze', { spec: SPEC, report })
    expect(r.status).toBe(200)
    const data = r.body.data as { dir: string; files: string[]; dshCommand: string }
    expect(data.files).toHaveLength(5)
    expect(existsSync(join(data.dir, 'demo-sorter.gate.yaml'))).toBe(true)
    expect(data.dshCommand).toContain('--profile web')
  })

  it('freeze:缺报告 400', async () => {
    const r = await post('/api/freeze', { spec: SPEC })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('报告')
  })

  it('explore:自动探索——AI 自造样例跑全链路,产物随报告返回', async () => {
    const r = await post('/api/explore', { spec: SPEC })
    expect(r.status).toBe(200)
    const data = r.body.data as { samples: Array<{ name: string; expect: string }>; report: { matchRate: number; results: Array<{ record?: unknown }> } }
    expect(data.samples.map((x) => x.expect)).toEqual(['pass', 'pass', 'block'])
    expect(data.report.matchRate).toBe(1)
    expect(data.report.results[0]!.record).toMatchObject({ amount: 428 })
    expect(data.report.results[2]!.record).toBeUndefined() // 反例被拦,无产物
  })

  it('explore:可附加用户真实样例一起跑', async () => {
    const r = await post('/api/explore', { spec: SPEC, samples: [{ source: '午餐 金额 428 元' }] })
    const data = r.body.data as { samples: Array<{ name: string }> }
    expect(data.samples.some((x) => x.name === '真实样例1')).toBe(true)
  })

  it('未知路径 404', async () => {
    const r = await post('/api/nope', {})
    expect(r.status).toBe(404)
  })

  it('日志可查:/api/logs 记录流程与 LLM 调用', async () => {
    await post('/api/draft', { description: '帮我整理' })
    const res = await fetch(base + '/api/logs')
    const { data } = (await res.json()) as { data: { logs: Array<{ tag: string; msg: string }> } }
    const tags = data.logs.map((l) => l.tag)
    expect(tags).toContain('draft')
    expect(tags).toContain('llm')
    expect(data.logs.some((l) => l.msg.includes('规格就绪'))).toBe(true)
  })

  it('SSE:/api/events 是事件流并回放历史', async () => {
    const controller = new AbortController()
    const res = await fetch(base + '/api/events', { signal: controller.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('data: ')
    expect(text).toContain('服务就绪')
    controller.abort()
  })

  it('verify 过程产生 gate/review 流水线日志', async () => {
    await post('/api/verify', { spec: SPEC, samples: [{ source: '午餐 金额 428 元' }] })
    const res = await fetch(base + '/api/logs')
    const { data } = (await res.json()) as { data: { logs: Array<{ tag: string; msg: string }> } }
    expect(data.logs.some((l) => l.tag === 'gate' && l.msg.includes('门禁通过'))).toBe(true)
    expect(data.logs.some((l) => l.tag === 'review' && l.msg.includes('④评审通过'))).toBe(true)
    expect(data.logs.some((l) => l.tag === 'verify' && l.msg.includes('符合预期'))).toBe(true)
  })
})
