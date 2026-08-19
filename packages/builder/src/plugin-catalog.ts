/**
 * 插件生态消费:读收集器产出的清单,按任务描述挑相关插件喂给设计 AI。
 * 这是"收集来的生态被 AI 消费"的落点——设计 agent 方案时,知道生态里有哪些现成能力可接。
 */
import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'

export interface PluginEntry {
  readonly name: string
  readonly url: string
  readonly description: string
  readonly stars: number
  readonly trust: string
}

/** 读清单文件。不存在或损坏返回空数组(生态可缺,不阻塞设计)。 */
export function readCatalog(path: string): readonly PluginEntry[] {
  if (!existsSync(path)) return []
  let raw: unknown
  try {
    raw = parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  const plugins = (raw as { plugins?: unknown })?.plugins
  if (!Array.isArray(plugins)) return []
  return plugins.flatMap((p): PluginEntry[] => {
    if (typeof p !== 'object' || p === null) return []
    const o = p as Record<string, unknown>
    if (typeof o.name !== 'string') return []
    return [{
      name: o.name,
      url: typeof o.url === 'string' ? o.url : '',
      description: typeof o.description === 'string' ? o.description : '',
      stars: typeof o.stars === 'number' ? o.stars : 0,
      trust: typeof o.trust === 'string' ? o.trust : '待核实',
    }]
  })
}

const STOP = new Set(['plugin', 'dsh', 'deepseek', 'harness', 'cordis', 'the', 'for', 'and'])

/**
 * 分词:拉丁词按空白/符号切;中日韩(无空格)按相邻 2 字组(bigram),
 * 这样"发票信息抽取"与"…发票…抽取…"能通过共享 bigram 命中。
 */
function tokens(text: string): string[] {
  const out: string[] = []
  const cjk = /[一-鿿぀-ヿ]/
  // 拉丁/数字词
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (/^[a-z0-9]+$/.test(w) && w.length >= 2 && !STOP.has(w)) out.push(w)
  }
  // CJK 字符流 → 2 字组
  const chars = [...text].filter((c) => cjk.test(c))
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!)
  return out
}

/**
 * 按任务描述挑最相关的插件(名称+描述关键词命中打分,star 作次序)。
 * 纯确定性,不调模型——先粗筛,选出的候选再交给设计 AI 判断要不要用。
 */
export function relevantPlugins(catalog: readonly PluginEntry[], taskText: string, limit = 5): readonly PluginEntry[] {
  const qs = new Set(tokens(taskText))
  if (qs.size === 0) return []
  const scored = catalog
    .map((p) => {
      const hay = new Set(tokens(`${p.name} ${p.description}`))
      let hit = 0
      for (const q of qs) if (hay.has(q)) hit++
      return { p, hit }
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || b.p.stars - a.p.stars)
  return scored.slice(0, limit).map((x) => x.p)
}

/** 把候选插件渲染成喂给设计 AI 的提示文本。空则返回空串。 */
export function pluginsHint(plugins: readonly PluginEntry[]): string {
  if (plugins.length === 0) return ''
  return [
    '【生态里可能相关的现成插件(来自每日自动收集,均为待核实,仅供参考)】',
    ...plugins.map((p) => `- ${p.name}(★${p.stars}):${p.description.slice(0, 80)}`),
    '如果其中某个能覆盖任务需要的能力,可在设计里考虑接入;不相关就忽略,不要硬凑。',
  ].join('\n')
}
