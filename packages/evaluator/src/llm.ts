/**
 * LLM 客户端抽象 + DeepSeek 实现。
 * 评审逻辑只依赖 ChatClient 接口，单测用假客户端，真跑用 DeepSeek。
 */

export interface ChatMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

/** 极简聊天客户端：一组消息进，一段文本出。 */
export interface ChatClient {
  chat(messages: readonly ChatMessage[]): Promise<string>
}

export interface DeepSeekConfig {
  /** API key（从环境变量取，不落盘） */
  readonly apiKey: string
  /** 模型名，默认 deepseek-chat */
  readonly model?: string
  /** API 地址，默认官方 */
  readonly baseUrl?: string
  /** 超时毫秒，默认 60000 */
  readonly timeoutMs?: number
}

/** DeepSeek 聊天客户端（OpenAI 兼容协议）。 */
export function createDeepSeekClient(config: DeepSeekConfig): ChatClient {
  const { apiKey, model = 'deepseek-chat', baseUrl = 'https://api.deepseek.com', timeoutMs = 60_000 } = config
  if (apiKey.trim() === '') throw new Error('DeepSeek apiKey 为空')

  return {
    async chat(messages) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            response_format: { type: 'json_object' },
          }),
        })
        if (!res.ok) {
          const body = await res.text()
          throw new Error(`DeepSeek API ${res.status}：${body.slice(0, 300)}`)
        }
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const content = data.choices?.[0]?.message?.content
        if (typeof content !== 'string' || content === '') {
          throw new Error('DeepSeek API 返回里没有内容')
        }
        return content
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
