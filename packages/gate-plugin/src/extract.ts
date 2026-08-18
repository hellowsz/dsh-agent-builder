/**
 * 从 agent 最终答复的文本里抽出待验收的结构化产出（JSON 对象）。
 * 约定：agent 被要求把成品放在最后一个 ```json 围栏里；没有围栏时尝试整段解析。
 */

function tryParseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // 不是合法 JSON，交回调用方按"未产出结构化结果"处理
  }
  return undefined
}

/** 抽出最后一个 ```json 围栏（或整段 JSON）。返回 undefined 表示没有可验收的结构化产出。 */
export function extractJsonRecord(text: string): Record<string, unknown> | undefined {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  const last = fences.at(-1)?.[1]
  if (last !== undefined) {
    const parsed = tryParseRecord(last.trim())
    if (parsed !== undefined) return parsed
  }
  return tryParseRecord(text.trim())
}
