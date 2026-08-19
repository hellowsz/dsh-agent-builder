import { describe, expect, it } from 'vitest'
import { filterCandidates, looksLikePlugin, mergeCandidates, renderCatalog, type RepoCandidate } from '../src/catalog.js'
import { parseRestSearch } from '../src/github.js'

const NOW = new Date('2026-08-18T00:00:00Z')

const mk = (fullName: string, over: Partial<RepoCandidate> = {}): RepoCandidate => ({
  fullName,
  url: `https://github.com/${fullName}`,
  description: 'A cordis plugin for DSH',
  stars: 10,
  updatedAt: '2026-08-10T00:00:00Z',
  ...over,
})

describe('筛选', () => {
  it('剔除明显非插件（awesome 列表/桌面壳/教程）', () => {
    expect(looksLikePlugin(mk('a/awesome-dsh-plugin'))).toBe(false)
    expect(looksLikePlugin(mk('a/dsh-desktop', { description: 'Desktop client' }))).toBe(false)
    expect(looksLikePlugin(mk('a/dsh-ocr-local'))).toBe(true)
  })

  it('按 star 下限与活跃期筛', () => {
    const list = [
      mk('a/fresh'),
      mk('a/stale', { updatedAt: '2024-01-01T00:00:00Z' }),
      mk('a/low-star', { stars: 1 }),
      mk('a/bad-date', { updatedAt: '???' }),
    ]
    const kept = filterCandidates(list, { now: NOW, minStars: 5 })
    expect(kept.map((c) => c.fullName)).toEqual(['a/fresh'])
  })
})

describe('合并与渲染', () => {
  it('跨查询去重并记录命中来源，按 star 排序', () => {
    const batches = new Map([
      ['q1', [mk('a/x', { stars: 5 }), mk('a/y', { stars: 50 })]],
      ['q2', [mk('a/x', { stars: 5 })]],
    ])
    const entries = mergeCandidates(batches)
    expect(entries.map((e) => e.fullName)).toEqual(['a/y', 'a/x'])
    expect(entries.find((e) => e.fullName === 'a/x')?.foundBy).toEqual(['q1', 'q2'])
    expect(entries.every((e) => e.trust === '待核实')).toBe(true)
  })

  it('清单 YAML 带来源与可信度警示', () => {
    const yaml = renderCatalog(mergeCandidates(new Map([['q', [mk('a/x')]]])), '2026-08-18T00:00:00.000Z')
    expect(yaml).toContain('a/x')
    expect(yaml).toContain('待核实')
    expect(yaml).toContain('接入前必须自行确认')
  })
})

describe('GitHub REST 解析（边界）', () => {
  it('解析 items，容忍 description 为 null，pushed_at 作 updatedAt', () => {
    const out = parseRestSearch(JSON.stringify({ items: [
      { full_name: 'a/x', html_url: 'https://github.com/a/x', description: null, stargazers_count: 3, pushed_at: '2026-08-01T00:00:00Z' },
    ] }))
    expect(out).toEqual([{ fullName: 'a/x', url: 'https://github.com/a/x', description: '', stars: 3, updatedAt: '2026-08-01T00:00:00Z' }])
  })

  it('缺关键字段的条目被丢弃', () => {
    expect(parseRestSearch('{"items":[{"description":"no name"}]}')).toEqual([])
  })

  it('缺 items 抛错', () => {
    expect(() => parseRestSearch('{}')).toThrow(/items/)
  })
})
