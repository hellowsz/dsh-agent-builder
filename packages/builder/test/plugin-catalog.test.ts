import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCatalog, relevantPlugins, pluginsHint } from '../src/plugin-catalog.js'

const CAT = `
version: 1
plugins:
  - { name: a/dsh-ocr-local, url: 'https://x/a', description: '本地 OCR 识别图片文字', stars: 50, trust: 待核实 }
  - { name: b/dsh-invoice, url: 'https://x/b', description: '发票信息抽取', stars: 20, trust: 待核实 }
  - { name: c/dsh-pet, url: 'https://x/c', description: '桌面宠物动画', stars: 5, trust: 待核实 }
`

describe('插件生态消费', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'cat-')), 'catalog.yaml')
  writeFileSync(p, CAT)

  it('读清单', () => {
    const c = readCatalog(p)
    expect(c).toHaveLength(3)
    expect(c[0]).toMatchObject({ name: 'a/dsh-ocr-local', stars: 50 })
  })

  it('不存在的文件返回空,不崩', () => {
    expect(readCatalog('/nope/x.yaml')).toEqual([])
  })

  it('按任务描述挑相关插件,不相关的不选', () => {
    const c = readCatalog(p)
    const rel = relevantPlugins(c, '我要把发票文字抽取成结构化数据', 5)
    expect(rel.map((x) => x.name)).toContain('b/dsh-invoice')
    expect(rel.map((x) => x.name)).not.toContain('c/dsh-pet')
  })

  it('pluginsHint 渲染或空串', () => {
    expect(pluginsHint([])).toBe('')
    const h = pluginsHint(readCatalog(p).slice(0, 1))
    expect(h).toContain('dsh-ocr-local')
    expect(h).toContain('待核实')
  })
})
