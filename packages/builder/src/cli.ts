#!/usr/bin/env node
/**
 * 专业 CLI 模式:与网页共用同一任务库(sessions/)与同一条流水——
 * 设计(builder)→ 候选配置交真 DSH 执行 → builder 评审产物 → 用户确认定稿 → 进资产库。
 * 模型通道:设 DEEPSEEK_API_KEY 直连,否则本机 dsh headless。
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, exit, env, cwd } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createDeepSeekClient, createDshHeadlessClient, type ChatClient } from '@dsh-agent-builder/evaluator'
import { draftSpec } from './interview.js'
import { deriveGate } from './derive.js'
import { generateSamples } from './explore.js'
import { writeCandidate } from './candidate.js'
import { createDshProducer } from './dsh-runner.js'
import { runStability, renderReport, type PipelineEvent, type Sample, type StabilityReport } from './stability.js'
import { collectWebMaterials } from './web-material.js'
import { mergeSampleBank, tierOf, TIER_LABEL } from './confidence.js'
import { readRuntimeBlocks, readRuntimeEvidence } from './runtime-feedback.js'
import { freeze } from './freeze.js'
import { TaskStore, type BuilderTask } from './tasks.js'
import { type TaskSpec } from './spec.js'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '../../..')
const SESSIONS = join(REPO, 'sessions')
const ASSETS = join(REPO, 'agents')
const PLUGIN = join(REPO, 'packages/gate-plugin/dist/gate-plugin.mjs')

const apiKey = env.DEEPSEEK_API_KEY ?? ''
const makeClient = (): ChatClient => (apiKey !== '' ? createDeepSeekClient({ apiKey }) : createDshHeadlessClient())
const workClient = makeClient()
const reviewClient = makeClient()
const store = new TaskStore(SESSIONS)

function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---- 行读取(兼容 TTY 与管道) ----
function createLineReader() {
  const rl = createInterface({ input: stdin, output: stdout })
  const queue: string[] = []
  const waiters: Array<(s: string) => void> = []
  let closed = false
  rl.on('line', (l) => { const w = waiters.shift(); if (w !== undefined) w(l); else queue.push(l) })
  rl.on('close', () => { closed = true; for (const w of waiters.splice(0)) w('') })
  return {
    async ask(prompt: string): Promise<string> {
      stdout.write(prompt)
      const q = queue.shift()
      if (q !== undefined) { stdout.write(`${q}\n`); return q }
      if (closed) return ''
      return new Promise((res) => waiters.push(res))
    },
    close(): void { if (!closed) rl.close() },
  }
}
const rl = createLineReader()

const log = (tag: string, msg: string) => stdout.write(`  [${tag}] ${msg}\n`)

function pipelinePrinter(): (e: PipelineEvent) => void {
  return (e) => {
    switch (e.type) {
      case 'sample:start': log('exec', `▶ ${e.sample} 交 DSH 拼装…`); break
      case 'work:done': log('exec', `${e.sample} DSH 产出(${Math.round(e.ms / 1000)}s,${e.chars} 字)`); break
      case 'gate:verdict': log('gate', `${e.sample} 门禁${e.passed ? '通过' : `拦下:${e.issues.join('、')}`}`); break
      case 'review:done': log('review', `${e.sample} ④评审${e.passed ? '通过' : `未过:${e.error ?? e.issues.join('、')}`}`); break
      case 'sample:done': log('verify', `■ ${e.sample}:${e.actual}${e.ok ? '(符合预期)' : '(不符合预期)'}`); break
    }
  }
}

function showSpec(spec: TaskSpec): void {
  stdout.write(`\n── 拼接说明书(方案)──\n任务:${spec.title} — ${spec.description}\n输出字段:\n`)
  for (const f of spec.fields) {
    stdout.write(`  - ${f.label}(${f.kind}${f.kind === 'enum' ? `:${(f.values ?? []).join('/')}` : ''}${f.optional === true ? ',可空' : ''})\n`)
  }
  stdout.write('硬规则:\n')
  for (const r of spec.rules) stdout.write(`  - ${r.message ?? r.id}\n`)
  if (spec.rules.length === 0) stdout.write('  (无)\n')
  stdout.write('软判断(④评审):\n')
  for (const a of spec.aiReview) stdout.write(`  - ${a.criteria}\n`)
  if (spec.aiReview.length === 0) stdout.write('  (无)\n')
}

const ORIGIN_LABEL: Record<string, string> = { synthetic: '合成', web: '网络素材', real: '真实样例', runtime: '线上回流' }

function showProducts(samples: readonly Sample[] | undefined, report: StabilityReport): void {
  const bySource = new Map((samples ?? []).map((s) => [s.name, s.source]))
  const byOrigin = new Map((samples ?? []).map((s) => [s.name, s.origin ?? 'synthetic']))
  stdout.write(`\n${renderReport({ title: '' } as TaskSpec, report).split('\n').slice(2).join('\n')}\n`)
  for (const r of report.results) {
    stdout.write(`\n── ${r.name}[${ORIGIN_LABEL[byOrigin.get(r.name) ?? 'synthetic']}] ${r.ok ? '✓ 符合预期' : '✗ 不符合预期'} ──\n`)
    stdout.write(`原文: ${(bySource.get(r.name) ?? '').slice(0, 120)}\n`)
    if (r.record !== undefined) {
      stdout.write('产物:\n')
      for (const [k, v] of Object.entries(r.record)) stdout.write(`  ${k}: ${v === null ? '(空)' : String(v)}\n`)
    } else {
      stdout.write(`产物: (被拦下${r.expect === 'block' ? ' — 符合预期,拒绝了无关输入' : ''})\n`)
    }
    if (r.files !== undefined && r.files.length > 0) {
      stdout.write('产出文件:\n')
      for (const f of r.files) stdout.write(`  ${f.path}(${Math.round(f.bytes / 1024)} KB)\n`)
    }
  }
}

async function exploreTask(task: BuilderTask, extra: readonly Sample[]): Promise<BuilderTask> {
  const spec = task.spec
  if (spec === undefined) throw new Error('先起草说明书')
  const bankBefore = task.samples ?? []
  const incoming: Sample[] = extra.map((x) => ({ ...x, origin: 'real' as const }))
  if (bankBefore.length === 0) {
    log('explore', 'AI 自造样例(正例+无关反例)…')
    incoming.push(...await generateSamples(workClient, spec, 2))
  }
  if (![...bankBefore, ...incoming].some((x) => x.origin === 'web')) {
    log('explore', '上网采集真实素材…')
    const webSamples = await collectWebMaterials(workClient, spec, 1)
    log('explore', webSamples.length > 0 ? `网络素材 ${webSamples.length} 条入集` : '网络素材采集失败,本轮以合成为主(信心上限 🥉)')
    incoming.push(...webSamples)
  }
  if (task.frozen !== undefined) {
    const blocks = readRuntimeBlocks(join(task.frozen.dir, 'runtime-feedback.jsonl'))
    if (blocks.length > 0) log('explore', `回流 ${blocks.length} 条线上翻车样本进回归集`)
    incoming.push(...blocks)
  }
  const samples = mergeSampleBank(bankBefore, incoming)
  const candidate = writeCandidate(spec, join(SESSIONS, task.id, 'candidate'), { pluginPath: PLUGIN })
  log('exec', `回归样例集 ${samples.length} 条(历史 ${bankBefore.length})→ 候选配置交 DeepSeek Harness 全量执行`)
  const gate = deriveGate(spec)
  const report = await runStability(spec, gate, samples, {
    workClient, reviewClient, today: localToday(),
    produce: createDshProducer({ presetFile: candidate.presetFile }),
    onEvent: pipelinePrinter(),
  })
  const tier = tierOf(samples, report)
  log('verify', `信心等级:${TIER_LABEL[tier]}`)
  return store.update(task.id, { samples, report, tier, status: 'review' })
}

async function runTask(id: string): Promise<void> {
  let task = store.get(id)
  for (;;) {
    if (task.status === 'draft' && task.spec === undefined) {
      log('draft', '起草拼接说明书…')
      const spec = await draftSpec(workClient, task.description)
      task = store.update(task.id, { spec, title: spec.title })
    }
    if (task.status === 'draft') {
      showSpec(task.spec!)
      const a = (await rl.ask('\n确认这份说明书吗?(y=确认并交 DSH 探索 / 输入修改意见 / b=返回)\n> ')).trim()
      if (a.toLowerCase() === 'b') return
      if (a.toLowerCase() !== 'y') {
        log('draft', '按意见修订…')
        const spec = await draftSpec(workClient, `${task.description}\n\n用户的修改意见:${a}`)
        task = store.update(task.id, { spec, title: spec.title })
        continue
      }
      task = await exploreTask(task, [])
      continue
    }
    if (task.status === 'review') {
      showProducts(task.samples, task.report!)
      const a = (await rl.ask('\n产物满足需求吗?(y=定稿进资产库 / r=补充真实样例再跑 / 输入意见=改方案重探索 / b=返回)\n> ')).trim()
      if (a.toLowerCase() === 'b') return
      if (a.toLowerCase() === 'y') {
        const spec = task.spec!
        const result = freeze(spec, task.report!, ASSETS, {
          pluginPath: PLUGIN,
          gateFilePath: join(ASSETS, spec.name, `${spec.name}.gate.yaml`),
        }, task.samples)
        task = store.update(task.id, { status: 'frozen', frozen: {
          dir: result.dir, files: result.files,
          dshCommand: `npx -y @deepseek-ai/dsh --patch ${result.dir}/${spec.name}.preset.yaml --profile web --port 3080`,
        } })
        continue
      }
      if (a.toLowerCase() === 'r') {
        const line = (await rl.ask('贴一条真实原文> ')).trim()
        task = await exploreTask(task, line === '' ? [] : [{ name: '真实样例1', source: line, expect: 'pass' }])
        continue
      }
      log('draft', '按产物意见修订说明书…')
      const spec = await draftSpec(workClient, `${task.description}\n\n用户的修改意见:${a}`)
      task = store.update(task.id, { spec, title: spec.title, status: 'draft' })
      task = await exploreTask(task, [])
      continue
    }
    if (task.status === 'frozen') {
      stdout.write(`\n🎉 说明书已定稿,进入资产库:\n  ${task.frozen!.dir}\n一键使用:\n  ${task.frozen!.dshCommand}\n`)
      return
    }
  }
}

function listAssets(): Array<{ name: string; title: string; presetFile: string }> {
  if (!existsSync(ASSETS)) return []
  return readdirSync(ASSETS).flatMap((name) => {
    const specFile = join(ASSETS, name, 'spec.json')
    const presetFile = join(ASSETS, name, `${name}.preset.yaml`)
    if (!existsSync(specFile) || !existsSync(presetFile)) return []
    const spec = JSON.parse(readFileSync(specFile, 'utf8')) as TaskSpec
    return [{ name, title: spec.title, presetFile }]
  })
}

async function assetsMenu(): Promise<void> {
  const assets = listAssets()
  if (assets.length === 0) { stdout.write('资产库为空——定稿一个任务后再来。\n'); return }
  stdout.write('\n── 用户资产(已定稿的 harness 配置)──\n')
  assets.forEach((a, i) => {
    const ev = readRuntimeEvidence(join(ASSETS, a.name, 'runtime-feedback.jsonl'))
    const fb = ev.blockedTotal > 0 ? ` | 线上翻车 ${ev.blockedTotal}(打开任务重新探索即回流再版)` : ''
    stdout.write(`  [${i + 1}] ${a.title}(${a.name})${fb}\n`)
  })
  const a = (await rl.ask('输入序号一键启动使用,回车返回> ')).trim()
  const idx = Number.parseInt(a, 10) - 1
  const chosen = assets[idx]
  if (chosen === undefined) return
  stdout.write(`启动 ${chosen.title} …(装配约 30-60 秒)\n`)
  spawn('npx', ['-y', '@deepseek-ai/dsh', '--patch', chosen.presetFile, '--profile', 'web', '--port', '3080'], { detached: true, stdio: 'ignore' }).unref()
  const url = 'http://127.0.0.1:3080'
  let ready = false
  for (let i = 0; i < 45 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 1500)
      ready = (await fetch(url, { signal: controller.signal })).ok
      clearTimeout(t)
    } catch { /* 未就绪,继续等 */ }
  }
  if (!ready) { stdout.write('DSH 启动超时,请手动检查。\n'); return }
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref() // 直接打开已装配好的页面
  stdout.write(`已就绪并为你打开:${url}(直接贴原文使用,四层门禁在岗)\n`)
}

async function main(): Promise<void> {
  stdout.write(`=== dsh-agent-builder CLI ===\n模型通道:${apiKey !== '' ? 'DeepSeek 直连' : '本机 dsh headless(每步约 1-2 分钟)'}\n工作目录:${cwd()}\n`)
  for (;;) {
    const tasks = store.list()
    stdout.write('\n── 任务 ──\n')
    const stName = { draft: '起草中', review: '待评估', frozen: '已定稿' } as const
    tasks.forEach((t, i) => stdout.write(`  [${i + 1}] ${t.title}(${stName[t.status]})\n`))
    if (tasks.length === 0) stdout.write('  (空)\n')
    const a = (await rl.ask('命令: n=新建任务  <序号>=打开  a=资产库  q=退出\n> ')).trim().toLowerCase()
    if (a === 'q' || a === '') break
    if (a === 'a') { await assetsMenu(); continue }
    if (a === 'n') {
      const description = (await rl.ask('用大白话说:你想要一个帮你整理什么的 agent?\n> ')).trim()
      if (description === '') continue
      const task = store.create(description)
      await runTask(task.id)
      continue
    }
    const idx = Number.parseInt(a, 10) - 1
    const chosen = tasks[idx]
    if (chosen !== undefined) await runTask(chosen.id)
  }
  rl.close()
}

main().catch((e: unknown) => {
  stdout.write(`出错:${e instanceof Error ? e.message : String(e)}\n`)
  exit(1)
})
