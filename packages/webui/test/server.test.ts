import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
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
const catalogPath = join(mkdtempSync(join(tmpdir(), 'webui-cat-')), 'catalog.yaml')
writeFileSync(catalogPath, `
version: 1
plugins:
  - { name: a/dsh-invoice, url: 'https://x/a', description: '发票信息抽取', stars: 30, trust: 待核实 }
  - { name: b/dsh-pet, url: 'https://x/b', description: '桌面宠物', stars: 5, trust: 待核实 }
`)
// 假执行器:模拟"候选配置交 DSH 执行"——按样例原文回产物(不真起 DSH);
// 每个样例写一个交付文件进 runsDir,模拟 PPT 类文件产物
const produceFactory = (presetFile: string, runsDir?: string) => async (sample: { source: string; name: string }) => {
  if (!presetFile.endsWith('.preset.yaml')) throw new Error('candidate preset 未写盘')
  if (sample.source.includes('天气')) return '这段文字里没有可整理的信息。'
  const answer = sample.source.includes('56')
    ? '```json\n{"amount": 56, "note": "打车"}\n```'
    : '```json\n{"amount": 428, "note": "午餐"}\n```'
  if (runsDir !== undefined) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const dir = join(runsDir, sample.name.replace(/[^\p{L}\p{N}_-]+/gu, '_'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'deliverable.txt'), '演示交付物')
    return { answer, files: [{ name: 'deliverable.txt', path: join(dir, 'deliverable.txt'), bytes: 15 }] }
  }
  return answer
}
const launched: string[] = []
const launcher = async (presetFile: string) => { launched.push(presetFile); return 'http://127.0.0.1:3080' }
const materialsCollector = async () => [{ name: '网络素材1', source: '网络示例 金额 428 元', expect: 'pass' as const, origin: 'web' as const }]
const server = createWebuiServer({ workClient, reviewClient, outDir, pluginPath: '/tmp/fake-plugin.mjs', sessionsDir, produceFactory, launcher, materialsCollector, catalogPath })
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

  it('GET / 返回落地页(主能力入口)', async () => {
    const res = await fetch(base + '/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('能稳定交付结果')
    expect(html).toContain('/app')
  })

  it('GET /app 返回工作台', async () => {
    const res = await fetch(base + '/app')
    expect(res.status).toBe(200)
    const html = await res.text()
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

  it('explore:自造样例+网络素材(默认开),信心分级 silver', async () => {
    const r = await post('/api/explore', { taskId })
    expect(r.status).toBe(200)
    const task = (r.body.data as { task: { status: string; tier: string; samples: Array<{ origin?: string }>; report: { matchRate: number; results: Array<{ record?: unknown }> } } }).task
    expect(task.status).toBe('review')
    expect(task.samples.some((x) => x.origin === 'web')).toBe(true)
    expect(task.report.matchRate).toBe(1)
    expect(task.tier).toBe('silver') // 含 web 证据且全过
    expect(task.report.results[0]!.record).toMatchObject({ amount: 428 })
  })

  it('explore:回归样例集累积——补充真实样例后历史不丢、全量重跑', async () => {
    const before = await fetch(base + '/api/task?id=' + taskId).then((x) => x.json()) as { data: { task: { samples: unknown[] } } }
    const n0 = before.data.task.samples.length
    const r = await post('/api/explore', { taskId, samples: [{ source: '晚餐 金额 56 元' }] })
    const task = (r.body.data as { task: { samples: Array<{ name: string; origin?: string }>; report: { total: number } } }).task
    expect(task.samples.length).toBe(n0 + 1)
    expect(task.samples.some((x) => x.origin === 'real')).toBe(true)
    expect(task.report.total).toBe(task.samples.length) // 全量重跑,历史不丢
  })

  it('freeze:说明书定稿,任务变 frozen', async () => {
    const r = await post('/api/freeze', { taskId })
    expect(r.status).toBe(200)
    const task = (r.body.data as { task: { status: string; frozen: { files: string[] } } }).task
    expect(task.status).toBe('frozen')
    expect(task.frozen.files).toHaveLength(6)
    expect(task.frozen.files).toContain('meta.json')
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

  it('文件产物:报告携带 files,/api/run-file 可下载,路径穿越被拒', async () => {
    const res = await fetch(base + '/api/task?id=' + taskId)
    const { data } = (await res.json()) as { data: { task: { report: { results: Array<{ name: string; files?: Array<{ name: string }> }> } } } }
    const withFile = data.task.report.results.find((r) => r.files !== undefined)
    expect(withFile).toBeDefined()
    const dl = await fetch(base + '/api/run-file?taskId=' + taskId + '&file=' + encodeURIComponent(withFile!.name.replace(/[^\p{L}\p{N}_-]+/gu, '_') + '/deliverable.txt'))
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('演示交付物')
    const evil = await fetch(base + '/api/run-file?taskId=' + taskId + '&file=' + encodeURIComponent('../../' + taskId + '.json'))
    expect(evil.status).toBe(404)
  })

  it('设计与执行分离:探索时候选配置写进任务目录', async () => {
    const { existsSync: ex } = await import('node:fs')
    expect(ex(join(sessionsDir, taskId, 'candidate', 'demo-sorter.preset.yaml'))).toBe(true)
    expect(ex(join(sessionsDir, taskId, 'candidate', 'demo-sorter.gate.yaml'))).toBe(true)
  })

  it('资产库:定稿后 /api/assets 可见,带一键命令', async () => {
    const res = await fetch(base + '/api/assets')
    const { data } = (await res.json()) as { data: { assets: Array<{ name: string; title: string; dshCommand: string }> } }
    const asset = data.assets.find((a) => a.name === 'demo-sorter') as { title: string; dshCommand: string; tier: string; runtimeBlocked: number } | undefined
    expect(asset).toBeDefined()
    expect(asset!.title).toBe('演示整理助手')
    expect(asset!.dshCommand).toContain('--profile web')
    expect(asset!.tier).toBe('silver')
    expect(asset!.runtimeBlocked).toBe(0)
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

  it('生态清单:/api/plugins 列表 + 按 q 相关检索', async () => {
    const all = await fetch(base + '/api/plugins').then((x) => x.json()) as { data: { total: number; plugins: Array<{ name: string }> } }
    expect(all.data.total).toBe(2)
    const rel = await fetch(base + '/api/plugins?q=' + encodeURIComponent('发票抽取')).then((x) => x.json()) as { data: { plugins: Array<{ name: string }> } }
    expect(rel.data.plugins.map((p) => p.name)).toContain('a/dsh-invoice')
    expect(rel.data.plugins.map((p) => p.name)).not.toContain('b/dsh-pet')
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
