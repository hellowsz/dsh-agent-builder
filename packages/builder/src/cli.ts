#!/usr/bin/env node --experimental-strip-types
/**
 * 对话式搭建助手 CLI（面向纯新手的最小交互）。
 * 流程：描述任务 → 起草规格 → 清单确认 → 提供样例 → 跑稳定性验证 → 看报告 → 固化。
 * 模型通道：设了 DEEPSEEK_API_KEY 走直连；没设自动回落本机 dsh headless(凭证留在 dsh 里)。
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, exit, env, cwd } from 'node:process'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDeepSeekClient, createDshHeadlessClient, type ChatClient } from '@dsh-agent-builder/evaluator'
import { draftSpec } from './interview.js'
import { deriveGate } from './derive.js'
import { runStability, renderReport, type Sample } from './stability.js'
import { freeze } from './freeze.js'
import { type TaskSpec } from './spec.js'

function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function describeSpec(spec: TaskSpec): string {
  const fields = spec.fields
    .map((f) => `  - ${f.label}（${f.kind}${f.kind === 'enum' ? `：${(f.values ?? []).join('/')}` : ''}${f.optional === true ? '，可空' : ''}）`)
    .join('\n')
  const rules = spec.rules.map((r) => `  - ${r.message ?? r.id}`).join('\n') || '  （无）'
  const reviews = spec.aiReview.map((a) => `  - ${a.criteria}`).join('\n') || '  （无）'
  return [
    `任务：${spec.title} —— ${spec.description}`,
    '输出字段：', fields,
    '硬规则（机器每次都会查）：', rules,
    '软判断（另请独立 AI 评审员把关）：', reviews,
  ].join('\n')
}

/** 行队列读取器:兼容 TTY 与管道输入——先到的行排队,EOF 后返回空行,不再抛 readline was closed。 */
function createLineReader() {
  const rl = createInterface({ input: stdin, output: stdout })
  const queue: string[] = []
  const waiters: Array<(s: string) => void> = []
  let closed = false
  rl.on('line', (l) => {
    const w = waiters.shift()
    if (w !== undefined) w(l)
    else queue.push(l)
  })
  rl.on('close', () => {
    closed = true
    for (const w of waiters.splice(0)) w('')
  })
  return {
    async question(prompt: string): Promise<string> {
      stdout.write(prompt)
      const queued = queue.shift()
      if (queued !== undefined) {
        stdout.write(`${queued}\n`)
        return queued
      }
      if (closed) return ''
      return new Promise((res) => waiters.push(res))
    },
    close(): void {
      if (!closed) rl.close()
    },
  }
}

async function main(): Promise<void> {
  // 模型通道:有 DEEPSEEK_API_KEY 走直连,否则回落到本机 dsh headless(凭证留在 dsh 里)
  const apiKey = env.DEEPSEEK_API_KEY ?? ''
  const makeClient = (): ChatClient =>
    apiKey !== '' ? createDeepSeekClient({ apiKey }) : createDshHeadlessClient()
  stdout.write(apiKey !== '' ? '模型通道:DeepSeek 直连\n' : '模型通道:本机 dsh headless(每次调用含冷启动,约 30-60 秒,请耐心)\n')
  // 工作 agent 与评审各自独立的客户端（独立会话语义）
  const workClient = makeClient()
  const reviewClient = makeClient()
  const rl = createLineReader()

  stdout.write('=== dsh-agent-builder 搭建助手 ===\n用大白话说：你想要一个帮你整理什么的 agent？\n\n')
  const description = (await rl.question('> ')).trim()
  if (description === '') { stdout.write('没有输入，退出。\n'); exit(1) }

  stdout.write('\n正在整理你的需求……\n')
  let spec = await draftSpec(workClient, description)

  // 清单确认循环
  for (;;) {
    stdout.write(`\n${describeSpec(spec)}\n\n确认这样搭吗？(y=确认 / 直接输入修改意见)\n`)
    const answer = (await rl.question('> ')).trim()
    if (answer.toLowerCase() === 'y') break
    stdout.write('\n按你的意见重新整理……\n')
    spec = await draftSpec(workClient, `${description}\n\n用户的修改意见：${answer}`)
  }

  // 收样例
  stdout.write('\n请贴 1-3 个真实样例（每个一行原文；空行结束）：\n')
  const samples: Sample[] = []
  for (let i = 1; i <= 3; i++) {
    const line = (await rl.question(`样例${i}> `)).trim()
    if (line === '') break
    samples.push({ name: `样例${i}`, source: line, expect: 'pass' })
  }
  if (samples.length === 0) { stdout.write('至少要一个样例才能验证，退出。\n'); exit(1) }

  stdout.write('\n跑稳定性验证（工作 agent → 门禁 → 独立评审）……\n')
  const gate = deriveGate(spec)
  const report = await runStability(spec, gate, samples, { workClient, reviewClient, today: localToday() })
  stdout.write(`\n${renderReport(spec, report)}\n\n`)

  if (report.matchRate < 1) {
    stdout.write('有样例未达预期。仍要固化吗？(y=固化 / 其他=退出)\n')
    const go = (await rl.question('> ')).trim().toLowerCase()
    if (go !== 'y') { stdout.write('已退出，未固化。\n'); rl.close(); return }
  }

  const outDir = resolve(cwd(), 'agents')
  const pluginPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../gate-plugin/dist/gate-plugin.mjs')
  if (!existsSync(pluginPath)) {
    stdout.write(`提示:插件产物未构建(${pluginPath}),固化后使用前请先执行:pnpm --filter @dsh-agent-builder/gate-plugin build\n`)
  }
  const result = freeze(spec, report, outDir, {
    pluginPath,
    gateFilePath: resolve(outDir, spec.name, `${spec.name}.gate.yaml`),
  })
  stdout.write(`\n已固化到 ${result.dir}：\n${result.files.map((f) => `  - ${f}`).join('\n')}\n`)
  stdout.write(`\n在 DeepSeek Harness 里使用：dsh --patch ${result.dir}/${spec.name}.preset.yaml web\n`)
  rl.close()
}

main().catch((e: unknown) => {
  stdout.write(`出错：${e instanceof Error ? e.message : String(e)}\n`)
  exit(1)
})
