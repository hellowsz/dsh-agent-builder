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
const sessionsDir = mkdtempSync(join(tmpdir(), 'webui-sessions-'))
// 假执行器:模拟"候选配置交 DSH 执行"——按样例原文回产物(不真起 DSH)
const produceFactory = (presetFile: string) => async (sample: { source: string }) => {
  if (!presetFile.endsWith('.preset.yaml')) throw new Error('candidate preset 未写盘')
  if (sample.source.includes('天气')) return '这段文字里没有可整理的信息。'
  if (sample.source.includes('56')) return '```json\n{"amount": 56, "note": "打车"}\n```'
  return '```json\n{"amount": 428, "note": "午餐"}\n```'
}
const launched: string[] = []
const launcher = async (presetFile: string) => { launched.push(presetFile); return 'http://127.0.0.1:3080' }
const server = createWebuiServer({ workClient, reviewClient, outDir, pluginPath: '/tmp/fake-plugin.mjs', sessionsDir, produceFactory, launcher })
let base = ''

beforeAll(async () => {
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: unknown; error?: string } }
}

describe('webui 服务(任务制)', () => {
  let taskId = ''

  it('GET / 返回向导页', async () => {
    const res = await fetch(base + '/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('dsh-agent-builder')
    expect(html).toContain('PIPELINE')
    expect(html).toContain('CONSOLE')
    expect(html).toContain('/api/events')
  })

  it('新建任务并列表可见', async () => {
    const r = await post('/api/tasks', { description: '帮我整理报销' })
    expect(r.status).toBe(200)
    const task = (r.body.data as { task: { id: string; status: string } }).task
    taskId = task.id
    expect(task.status).toBe('draft')
    const list = await fetch(base + '/api/tasks').then((x) => x.json()) as { data: { tasks: Array<{ id: string }> } }
    expect(list.data.tasks.some((t) => t.id === taskId)).toBe(true)
  })

  it('空描述建任务 400', async () => {
    const r = await post('/api/tasks', { description: ' ' })
    expect(r.status).toBe(400)
  })

  it('draft:起草说明书,存回任务', async () => {
    const r = await post('/api/draft', { taskId })
    expect(r.status).toBe(200)
    const task = (r.body.data as { task: { spec: { name: string }; title: string } }).task
    expect(task.spec.name).toBe('demo-sorter')
    expect(task.title).toBe('演示整理助手')
  })

  it('explore:自造样例跑全链路,产物随任务返回', async () => {
    const r = await post('/api/explore', { taskId })
    expect(r.status).toBe(200)
    const task = (r.body.data as { task: { status: string; samples: Array<{ expect: string }>; report: { matchRate: number; results: Array<{ record?: unknown }> } } }).task
    expect(task.status).toBe('review')
    expect(task.samples.map((x) => x.expect)).toEqual(['pass', 'pass', 'block'])
    expect(task.report.matchRate).toBe(1)
    expect(task.report.results[0]!.record).toMatchObject({ amount: 428 })
  })

  it('explore:可附加用户真实样例', async () => {
    const r = await post('/api/explore', { taskId, samples: [{ source: '午餐 金额 428 元' }] })
    const task = (r.body.data as { task: { samples: Array<{ name: string }> } }).task
    expect(task.samples.some((x) => x.name === '真实样例1')).toBe(true)
  })

  it('freeze:说明书定稿,任务变 frozen', async () => {
    const r = await post('/api/freeze', { taskId })
    expect(r.status).toBe(200)
    const task = (r.body.data as { task: { status: string; frozen: { files: string[] } } }).task
    expect(task.status).toBe('frozen')
    expect(task.frozen.files).toHaveLength(5)
    expect(existsSync(join(outDir, 'demo-sorter', 'demo-sorter.gate.yaml'))).toBe(true)
  })

  it('持久化:新 TaskStore 从同一目录能恢复任务', async () => {
    const { TaskStore } = await import('@dsh-agent-builder/builder')
    const store2 = new TaskStore(sessionsDir)
    const revived = store2.get(taskId)
    expect(revived.status).toBe('frozen')
    expect(revived.spec?.name).toBe('demo-sorter')
    expect(revived.report?.matchRate).toBe(1)
  })

  it('draft:任务不存在报错', async () => {
    const r = await post('/api/draft', { taskId: 'task-nope' })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('任务不存在')
  })

  it('explore:未起草先探索报错', async () => {
    const created = await post('/api/tasks', { description: '另一个任务' })
    const id = (created.body.data as { task: { id: string } }).task.id
    const r = await post('/api/explore', { taskId: id })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('先起草')
  })

  it('设计与执行分离:探索时候选配置写进任务目录', async () => {
    const { existsSync: ex } = await import('node:fs')
    expect(ex(join(sessionsDir, taskId, 'candidate', 'demo-sorter.preset.yaml'))).toBe(true)
    expect(ex(join(sessionsDir, taskId, 'candidate', 'demo-sorter.gate.yaml'))).toBe(true)
  })

  it('资产库:定稿后 /api/assets 可见,带一键命令', async () => {
    const res = await fetch(base + '/api/assets')
    const { data } = (await res.json()) as { data: { assets: Array<{ name: string; title: string; dshCommand: string }> } }
    const asset = data.assets.find((a) => a.name === 'demo-sorter')
    expect(asset).toBeDefined()
    expect(asset!.title).toBe('演示整理助手')
    expect(asset!.dshCommand).toContain('--profile web')
  })

  it('一键启动:/api/assets/launch 调起 DSH 并返回 URL', async () => {
    const r = await post('/api/assets/launch', { name: 'demo-sorter' })
    expect(r.status).toBe(200)
    expect((r.body.data as { url: string }).url).toContain('127.0.0.1:3080')
    expect(launched[0]).toContain('demo-sorter.preset.yaml')
  })

  it('一键启动:不存在的资产报错', async () => {
    const r = await post('/api/assets/launch', { name: 'nope' })
    expect(r.status).toBe(400)
  })

  it('未知路径 404', async () => {
    const r = await post('/api/nope', {})
    expect(r.status).toBe(404)
  })

  it('日志可查:/api/logs 记录任务与流水线', async () => {
    const res = await fetch(base + '/api/logs')
    const { data } = (await res.json()) as { data: { logs: Array<{ tag: string; msg: string }> } }
    const tags = data.logs.map((l) => l.tag)
    expect(tags).toContain('task')
    expect(tags).toContain('draft')
    expect(tags).toContain('llm')
    expect(data.logs.some((l) => l.tag === 'gate' && l.msg.includes('门禁通过'))).toBe(true)
    expect(data.logs.some((l) => l.msg.includes('定稿'))).toBe(true)
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
})
