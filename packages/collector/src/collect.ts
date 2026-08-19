#!/usr/bin/env node
/**
 * 收集入口:跑全部查询 → 筛选 → 合并 → 与已有清单累积 → 写盘。
 * 一次性:  node collect.mjs [输出路径]
 * 定时体:  由 systemd timer 每天调用本入口(见 scripts/collector.timer)。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { argv, stdout } from 'node:process'
import { resolve } from 'node:path'
import { accumulate, filterCandidates, mergeCandidates, parseCatalog, renderCatalog, type RepoCandidate } from './catalog.js'
import { DEFAULT_QUERIES, searchRepos } from './github.js'

export async function collectOnce(outPath: string): Promise<{ total: number; added: number }> {
  const now = new Date()
  const batches = new Map<string, readonly RepoCandidate[]>()

  for (const query of DEFAULT_QUERIES) {
    stdout.write(`检索:${query} …`)
    try {
      const found = await searchRepos(query)
      const kept = filterCandidates(found, { now })
      batches.set(query, kept)
      stdout.write(` ${found.length} 条,筛后 ${kept.length} 条\n`)
    } catch (e) {
      stdout.write(` 失败:${e instanceof Error ? e.message : String(e)}\n`)
      batches.set(query, [])
    }
  }

  const current = mergeCandidates(batches)
  const previous = existsSync(outPath) ? parseCatalog(readFileSync(outPath, 'utf8')) : []
  const merged = accumulate(previous, current, now.toISOString())
  writeFileSync(outPath, renderCatalog(merged, now.toISOString()))
  const added = merged.length - previous.length
  stdout.write(`\n清单已更新 ${outPath}:共 ${merged.length} 条(本轮新增 ${added >= 0 ? added : 0},刷新 ${current.length})\n`)
  return { total: merged.length, added: added >= 0 ? added : 0 }
}

async function main(): Promise<void> {
  const out = resolve(argv[2] ?? 'catalog.yaml')
  await collectOnce(out)
}

// 作为主模块运行时执行(被 import 时不跑)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('collect.mjs') || process.argv[1]?.endsWith('collect.ts')) {
  main().catch((e: unknown) => {
    stdout.write(`收集失败:${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  })
}
