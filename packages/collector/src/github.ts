/**
 * GitHub 检索源：走 gh CLI（沿用本机已认证身份），JSON 输出解析成候选。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type RepoCandidate } from './catalog.js'

const execFileAsync = promisify(execFile)

/** 全网筛选用的查询集（多角度覆盖，谁也不完备）。 */
export const DEFAULT_QUERIES: readonly string[] = [
  'topic:dsh-plugin',
  'deepseek harness plugin',
  'dsh cordis plugin',
]

interface GhRepo {
  readonly fullName?: string
  readonly url?: string
  readonly description?: string | null
  readonly stargazersCount?: number
  readonly updatedAt?: string
}

/** 解析 gh search repos --json 的输出（系统边界，逐条校验）。 */
export function parseGhOutput(jsonText: string): readonly RepoCandidate[] {
  const raw: unknown = JSON.parse(jsonText)
  if (!Array.isArray(raw)) throw new Error('gh 输出不是数组')
  return raw
    .filter((r): r is GhRepo => typeof r === 'object' && r !== null)
    .flatMap((r) => {
      if (typeof r.fullName !== 'string' || typeof r.url !== 'string') return []
      return [{
        fullName: r.fullName,
        url: r.url,
        description: typeof r.description === 'string' ? r.description : '',
        stars: typeof r.stargazersCount === 'number' ? r.stargazersCount : 0,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
      }]
    })
}

/** 执行一个查询。topic: 前缀走 --topic，其余走关键词。 */
export async function searchRepos(query: string, limit = 30): Promise<readonly RepoCandidate[]> {
  const fields = 'fullName,url,description,stargazersCount,updatedAt'
  const args = query.startsWith('topic:')
    ? ['search', 'repos', '--topic', query.slice('topic:'.length), '--limit', String(limit), '--json', fields]
    : ['search', 'repos', query, '--limit', String(limit), '--json', fields]
  const { stdout } = await execFileAsync('gh', args, { timeout: 60_000 })
  return parseGhOutput(stdout)
}
