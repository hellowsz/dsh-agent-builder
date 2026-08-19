/**
 * GitHub 检索源:调 REST 搜索 API（fetch,两端通用,不依赖 gh CLI）。
 * 未认证 10 次/分钟即够（每天 3 个查询）；设 GITHUB_TOKEN 可提高额度。
 */
import { env } from 'node:process'
import { type RepoCandidate } from './catalog.js'

/** 全网筛选用的查询集（多角度覆盖,谁也不完备）。 */
export const DEFAULT_QUERIES: readonly string[] = [
  'topic:dsh-plugin',
  'deepseek harness plugin',
  'dsh cordis plugin',
]

interface RestRepo {
  readonly full_name?: string
  readonly html_url?: string
  readonly description?: string | null
  readonly stargazers_count?: number
  readonly pushed_at?: string
  readonly updated_at?: string
}

/** 解析 GitHub REST search 返回（系统边界,逐条校验）。 */
export function parseRestSearch(jsonText: string): readonly RepoCandidate[] {
  const raw: unknown = JSON.parse(jsonText)
  const items = (raw as { items?: unknown })?.items
  if (!Array.isArray(items)) throw new Error('GitHub 搜索返回缺少 items 数组')
  return items
    .filter((r): r is RestRepo => typeof r === 'object' && r !== null)
    .flatMap((r) => {
      if (typeof r.full_name !== 'string' || typeof r.html_url !== 'string') return []
      return [{
        fullName: r.full_name,
        url: r.html_url,
        description: typeof r.description === 'string' ? r.description : '',
        stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : 0,
        updatedAt: typeof r.pushed_at === 'string' ? r.pushed_at : (typeof r.updated_at === 'string' ? r.updated_at : ''),
      }]
    })
}

/** 执行一个查询。topic: 前缀原样进 q(GitHub 支持 q=topic:xxx)。 */
export async function searchRepos(query: string, limit = 30): Promise<readonly RepoCandidate[]> {
  const q = encodeURIComponent(query)
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit}`
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-agent-builder-collector',
  }
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN
  if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) throw new Error(`GitHub 搜索 HTTP ${res.status}`)
    return parseRestSearch(await res.text())
  } finally {
    clearTimeout(timer)
  }
}
