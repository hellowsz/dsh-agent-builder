import { describe, expect, it } from 'vitest'
import { accumulate, parseCatalog, renderCatalog, type CatalogEntry } from '../src/catalog.js'

const mk = (name: string, stars: number, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  fullName: name, url: `https://github.com/${name}`, description: 'x', stars, updatedAt: '2026-08-19T00:00:00Z',
  foundBy: ['q'], trust: '待核实', ...extra,
})

describe('跨轮累积', () => {
  it('新条目补 firstSeen;旧条目刷新 star+lastSeen;本轮未命中的旧条目保留', () => {
    const prev = [mk('a/old', 5, { firstSeen: '2026-08-01T00:00:00Z', lastSeen: '2026-08-18T00:00:00Z' }), mk('a/gone', 3, { firstSeen: '2026-08-10T00:00:00Z', lastSeen: '2026-08-10T00:00:00Z' })]
    const cur = [mk('a/old', 9), mk('a/new', 1)]
    const now = '2026-08-19T00:00:00Z'
    const m = accumulate(prev, cur, now)
    const byName = Object.fromEntries(m.map((e) => [e.fullName, e]))
    expect(byName['a/old'].stars).toBe(9)                       // 刷新
    expect(byName['a/old'].firstSeen).toBe('2026-08-01T00:00:00Z') // 保留首见
    expect(byName['a/old'].lastSeen).toBe(now)
    expect(byName['a/new'].firstSeen).toBe(now)                 // 新条目
    expect(byName['a/gone']).toBeDefined()                     // 本轮没搜到,保留
    expect(byName['a/gone'].lastSeen).toBe('2026-08-10T00:00:00Z')
  })

  it('人工已核验不被机械结果覆盖回待核实', () => {
    const prev = [mk('a/x', 5, { trust: '已核验' })]
    const cur = [mk('a/x', 6, { trust: '待核实' })]
    const m = accumulate(prev, cur, '2026-08-19T00:00:00Z')
    expect(m[0]!.trust).toBe('已核验')
  })

  it('render→parse 往返保真', () => {
    const entries = [mk('a/x', 7, { firstSeen: '2026-08-01T00:00:00Z', lastSeen: '2026-08-19T00:00:00Z' })]
    const back = parseCatalog(renderCatalog(entries, '2026-08-19T00:00:00Z'))
    expect(back[0]).toMatchObject({ fullName: 'a/x', stars: 7, firstSeen: '2026-08-01T00:00:00Z' })
  })
})
