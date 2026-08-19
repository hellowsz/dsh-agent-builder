/**
 * 运行期回流读取:解析定稿资产的 runtime-feedback.jsonl,
 * 产出信心分级用的线上证据 + 可供说明书再版的翻车样本。
 */
import { existsSync, readFileSync } from 'node:fs'
import { type RuntimeEvidence } from './confidence.js'
import { type Sample } from './stability.js'

interface FeedbackEntry {
  readonly ts?: string
  readonly kind?: string
  readonly source?: string
  readonly issues?: readonly string[]
}

function readEntries(file: string): readonly FeedbackEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        const e: unknown = JSON.parse(l)
        return typeof e === 'object' && e !== null ? [e as FeedbackEntry] : []
      } catch {
        return [] // 单行损坏不拖垮整读
      }
    })
}

/** 线上证据:末尾连续 pass 数 + 累计 block 数。 */
export function readRuntimeEvidence(file: string): RuntimeEvidence {
  const entries = readEntries(file)
  let cleanStreak = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.kind !== 'pass') break
    cleanStreak++
  }
  return { cleanStreak, blockedTotal: entries.filter((e) => e.kind === 'block').length }
}

/** 翻车样本(有原文的拦截记录),去重后转为再版样例(origin=runtime,期望修到 pass)。 */
export function readRuntimeBlocks(file: string): Sample[] {
  const seen = new Set<string>()
  const out: Sample[] = []
  for (const e of readEntries(file)) {
    if (e.kind !== 'block') continue
    const source = (e.source ?? '').trim()
    if (source === '' || seen.has(source)) continue
    seen.add(source)
    out.push({ name: `线上翻车${out.length + 1}`, source, expect: 'pass', origin: 'runtime' })
  }
  return out
}
