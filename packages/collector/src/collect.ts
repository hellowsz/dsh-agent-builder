#!/usr/bin/env node --experimental-strip-types
/**
 * 收集入口：跑全部查询 → 筛选 → 合并 → 写清单。
 * 用法：pnpm --filter @dsh-agent-builder/collector collect [输出路径]
 * （将来由定时任务 agent 周期性执行；本入口即其执行体。）
 */
import { writeFileSync } from 'node:fs'
import { argv, stdout } from 'node:process'
import { resolve } from 'node:path'
import { filterCandidates, mergeCandidates, renderCatalog, type RepoCandidate } from './catalog.js'
import { DEFAULT_QUERIES, searchRepos } from './github.js'

async function main(): Promise<void> {
  const out = resolve(argv[2] ?? 'catalog.yaml')
  const now = new Date()
  const batches = new Map<string, readonly RepoCandidate[]>()

  for (const query of DEFAULT_QUERIES) {
    stdout.write(`检索：${query} …`)
    try {
      const found = await searchRepos(query)
      const kept = filterCandidates(found, { now })
      batches.set(query, kept)
      stdout.write(` ${found.length} 条，筛后 ${kept.length} 条\n`)
    } catch (e) {
      // 单个查询失败不拖垮整轮收集，但必须让人看见
      stdout.write(` 失败：${e instanceof Error ? e.message : String(e)}\n`)
      batches.set(query, [])
    }
  }

  const entries = mergeCandidates(batches)
  writeFileSync(out, renderCatalog(entries, now.toISOString()))
  stdout.write(`\n清单已写入 ${out}（${entries.length} 条，全部标"待核实"）\n`)
}

main().catch((e: unknown) => {
  stdout.write(`收集失败：${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
})
