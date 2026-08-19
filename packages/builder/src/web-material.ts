/**
 * 网络素材:定稿前主动上互联网搜任务相关的真实素材,充实回归样例集。
 * 合成样例天然"考不倒自己"——网络素材带来分布外的真实写法(信心分级里算 web 级证据)。
 * 搜索失败不致命:降级为纯合成样例并如实记录。
 */
import { extractJsonRecord } from '@dsh-agent-builder/gate-engine'
import { type ChatClient } from '@dsh-agent-builder/evaluator'
import { type Sample } from './stability.js'
import { type TaskSpec } from './spec.js'

export interface WebSnippet {
  readonly title: string
  readonly snippet: string
}

/** 从 DuckDuckGo html 版结果页抽标题+摘要(无需 API key)。 */
export function parseDuckHtml(html: string, limit = 8): readonly WebSnippet[] {
  const out: WebSnippet[] = []
  const linkRe = /class="result__a"[^>]*>([\s\S]*?)<\/a>/g
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/g
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim()
  const titles = [...html.matchAll(linkRe)].map((m) => strip(m[1] ?? ''))
  const snippets = [...html.matchAll(snipRe)].map((m) => strip(m[1] ?? ''))
  for (let i = 0; i < Math.min(limit, titles.length); i++) {
    const title = titles[i] ?? ''
    const snippet = snippets[i] ?? ''
    if (title !== '' || snippet !== '') out.push({ title, snippet })
  }
  return out
}

/** 执行一次网络搜索。失败抛错,由调用方降级。 */
export async function searchWeb(query: string, timeoutMs = 20_000): Promise<readonly WebSnippet[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-agent-builder material collector)' },
    })
    if (!res.ok) throw new Error(`搜索请求失败:HTTP ${res.status}`)
    return parseDuckHtml(await res.text())
  } finally {
    clearTimeout(timer)
  }
}

const DISTILL_PROMPT = [
  '你是测试素材整理师。给你一批互联网搜索片段和一个"信息整理任务"的规格。',
  '任务:从片段里提炼/重组出贴近真实世界写法的输入原文素材(不是编造,是基于片段中出现的真实格式与词汇组织)。',
  '要求:每条素材必须包含规格必填字段可抽取的信息;数值日期要自洽;写法尽量保留片段里的真实风格。',
  '只输出 JSON:{"materials":["素材1","素材2"]},不要输出其他内容。',
].join('\n')

/**
 * 定稿前的网络素材采集:搜索 → LLM 提炼成可用样例(origin=web)。
 * 返回空数组表示本轮拿不到网络素材(网络不通/无可提炼内容),调用方继续用合成样例。
 */
export async function collectWebMaterials(
  client: ChatClient,
  spec: TaskSpec,
  count = 1,
): Promise<Sample[]> {
  const query = `${spec.title} 示例 文本`
  let snippets: readonly WebSnippet[]
  try {
    snippets = await searchWeb(query)
  } catch {
    return []
  }
  if (snippets.length === 0) return []

  const text = await client.chat([
    { role: 'system', content: DISTILL_PROMPT },
    {
      role: 'user',
      content: [
        `任务:${spec.title} —— ${spec.description}`,
        `必填字段:${spec.fields.filter((f) => f.optional !== true).map((f) => f.label).join('、')}`,
        '',
        '搜索片段:',
        ...snippets.map((s, i) => `${i + 1}. ${s.title}:${s.snippet}`),
        '',
        `请提炼 ${count} 条素材。`,
      ].join('\n'),
    },
  ])
  const raw = extractJsonRecord(text)
  const materials = Array.isArray(raw?.materials)
    ? raw.materials.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
    : []
  return materials.slice(0, count).map((source, i) => ({
    name: `网络素材${i + 1}`,
    source: source.trim(),
    expect: 'pass' as const,
    origin: 'web' as const,
  }))
}
