/**
 * 插件清单：条目模型、筛选、去重、合并与渲染。
 * 清单面向 AI 检索——字段齐、来源明、可信度标注诚实（收集≠可信，默认"待核实"）。
 */
import { stringify } from 'yaml'

/** 一条候选插件（来自公开仓库检索）。 */
export interface RepoCandidate {
  readonly fullName: string
  readonly url: string
  readonly description: string
  readonly stars: number
  /** ISO 时间 */
  readonly updatedAt: string
}

/** 清单条目。 */
export interface CatalogEntry extends RepoCandidate {
  /** 收集时的检索来源（哪个查询命中的） */
  readonly foundBy: readonly string[]
  /** 可信度：收集器只做机械筛选，一律"待核实"；人工/AI 核验后才升级 */
  readonly trust: '待核实' | '已核验'
}

export interface FilterOptions {
  /** star 下限（默认 0：新生态里新插件 star 少，不因此漏掉） */
  readonly minStars?: number
  /** 最近活跃天数上限（相对 now，默认 365） */
  readonly maxAgeDays?: number
  /** 判定"现在"的时刻（注入保证可测） */
  readonly now: Date
}

/** 明显不是插件的仓库（awesome 列表/桌面壳/教程），按名称与描述关键词剔除。 */
const NOT_PLUGIN_PATTERNS = [/awesome/i, /desktop/i, /tutorial/i, /guide/i, /橙皮书/, /指南/, /教程/]

/** 是否像一个插件仓库（保守：只剔除明显不是的）。 */
export function looksLikePlugin(candidate: RepoCandidate): boolean {
  const text = `${candidate.fullName} ${candidate.description}`
  return !NOT_PLUGIN_PATTERNS.some((re) => re.test(text))
}

/** 机械筛选：star 下限 + 活跃期 + 剔除非插件。 */
export function filterCandidates(
  candidates: readonly RepoCandidate[],
  options: FilterOptions,
): readonly RepoCandidate[] {
  const minStars = options.minStars ?? 0
  const maxAgeMs = (options.maxAgeDays ?? 365) * 24 * 3600 * 1000
  return candidates.filter((c) => {
    if (c.stars < minStars) return false
    const age = options.now.getTime() - Date.parse(c.updatedAt)
    if (!Number.isFinite(age) || age > maxAgeMs) return false
    return looksLikePlugin(c)
  })
}

/** 多个查询结果合并去重（按 fullName），记录每条被哪些查询命中。 */
export function mergeCandidates(
  batches: ReadonlyMap<string, readonly RepoCandidate[]>,
): readonly CatalogEntry[] {
  const merged = new Map<string, { candidate: RepoCandidate; foundBy: string[] }>()
  for (const [query, list] of batches) {
    for (const c of list) {
      const existing = merged.get(c.fullName)
      if (existing === undefined) merged.set(c.fullName, { candidate: c, foundBy: [query] })
      else existing.foundBy.push(query)
    }
  }
  return [...merged.values()]
    .map(({ candidate, foundBy }) => ({ ...candidate, foundBy, trust: '待核实' as const }))
    .sort((a, b) => b.stars - a.stars || a.fullName.localeCompare(b.fullName))
}

/** 渲染成 YAML 清单（面向 AI 检索的最终产物）。 */
export function renderCatalog(entries: readonly CatalogEntry[], generatedAt: string): string {
  return stringify({
    version: 1,
    generatedAt,
    note: '本清单由收集器机械筛选生成；trust=待核实 表示未经人工/AI 核验，接入前必须自行确认插件行为与安全性。',
    count: entries.length,
    plugins: entries.map((e) => ({
      name: e.fullName,
      url: e.url,
      description: e.description,
      stars: e.stars,
      updatedAt: e.updatedAt,
      foundBy: [...e.foundBy],
      trust: e.trust,
    })),
  })
}
