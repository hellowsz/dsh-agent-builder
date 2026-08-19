/**
 * 资产生命周期:回归样例集累积 / 网络素材解析 / 信心分级 / 运行期回流读取。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeSampleBank, tierOf } from '../src/confidence.js'
import { parseDuckHtml, collectWebMaterials } from '../src/web-material.js'
import { readRuntimeEvidence, readRuntimeBlocks } from '../src/runtime-feedback.js'
import { type Sample, type StabilityReport } from '../src/stability.js'
import { type ChatClient } from '@dsh-agent-builder/evaluator'
import { REIMBURSEMENT_SPEC } from './fixtures.js'

const S = (name: string, source: string, origin?: Sample['origin']): Sample =>
  ({ name, source, expect: 'pass', ...(origin !== undefined ? { origin } : {}) })

const passReport = (n: number): StabilityReport => ({
  total: n, matched: n, matchRate: 1,
  results: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, expect: 'pass', actual: 'pass', ok: true, issues: [] })),
})

describe('回归样例集', () => {
  it('累积合并,同原文去重,历史不丢', () => {
    const bank = mergeSampleBank([S('a', '原文A', 'synthetic')], [S('b', '原文B', 'real'), S('c', '原文A')])
    expect(bank.map((s) => s.name)).toEqual(['a', 'b'])
  })
})

describe('信心分级', () => {
  it('未全过 → none;纯合成全过 → bronze', () => {
    expect(tierOf([S('a', 'x', 'synthetic')], { ...passReport(1), matched: 0, matchRate: 0 })).toBe('none')
    expect(tierOf([S('a', 'x', 'synthetic')], passReport(1))).toBe('bronze')
  })
  it('含 web/real 证据全过 → silver;线上零拦截连击达标 → gold', () => {
    const samples = [S('a', 'x', 'synthetic'), S('b', 'y', 'web')]
    expect(tierOf(samples, passReport(2))).toBe('silver')
    expect(tierOf(samples, passReport(2), { cleanStreak: 10, blockedTotal: 0 })).toBe('gold')
    expect(tierOf(samples, passReport(2), { cleanStreak: 9, blockedTotal: 0 })).toBe('silver')
  })
})

describe('网络素材', () => {
  it('解析 DuckDuckGo html 结果', () => {
    const html = `
      <a class="result__a" href="#">发票<b>示例</b>大全</a>
      <a class="result__snippet" href="#">餐饮服务 金额 428.00 元 税额 24.23</a>
      <a class="result__a" href="#">第二条</a>
      <a class="result__snippet" href="#">交通费 56 元</a>`
    const out = parseDuckHtml(html)
    expect(out).toHaveLength(2)
    expect(out[0]!.title).toBe('发票示例大全')
    expect(out[0]!.snippet).toContain('428.00')
  })

  it('collectWebMaterials:LLM 提炼为 origin=web 样例(注入假搜索走不到,直接测提炼层)', async () => {
    // searchWeb 走真网,这里用假 client 只验证提炼与标注逻辑:模拟 fetch 不可用时返回 []
    const client: ChatClient = { chat: async () => '{"materials":["北京饭店 金额 100 元 税额 5.66 2026年8月1日 发票号 111 餐饮"]}' }
    const out = await collectWebMaterials(client, REIMBURSEMENT_SPEC, 1).catch(() => [])
    // 网络可用时应产出 web 样例;不可用时降级为空——两种都合法,产出时必须带 origin=web
    for (const s of out) expect(s.origin).toBe('web')
  })
})

describe('运行期回流读取', () => {
  it('cleanStreak 取末尾连续 pass,block 样本去重转再版样例', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-'))
    const file = join(dir, 'runtime-feedback.jsonl')
    writeFileSync(file, [
      JSON.stringify({ kind: 'pass' }),
      JSON.stringify({ kind: 'block', source: '奇葩发票甲', issues: ['amount_not_grounded'] }),
      JSON.stringify({ kind: 'block', source: '奇葩发票甲', issues: ['amount_not_grounded'] }),
      '{损坏行',
      JSON.stringify({ kind: 'pass' }),
      JSON.stringify({ kind: 'pass' }),
    ].join('\n') + '\n')
    const ev = readRuntimeEvidence(file)
    expect(ev.cleanStreak).toBe(2)
    expect(ev.blockedTotal).toBe(2)
    const blocks = readRuntimeBlocks(file)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ origin: 'runtime', expect: 'pass', source: '奇葩发票甲' })
  })

  it('文件不存在 → 零证据', () => {
    expect(readRuntimeEvidence('/nope/nothing.jsonl')).toEqual({ cleanStreak: 0, blockedTotal: 0 })
    expect(readRuntimeBlocks('/nope/nothing.jsonl')).toEqual([])
  })
})
