/**
 * DSH headless 通道：用本机 dsh(已配好 DeepSeek 凭证)当 ChatClient。
 * `dsh --profile headless "<prompt>"` 一次性答题——密钥留在 dsh 的凭证库里，不经过本进程。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type ChatClient, type ChatMessage } from './llm.js'

const execFileAsync = promisify(execFile)

export interface DshHeadlessConfig {
  /** dsh 可执行方式，默认 ['npx', '-y', '@deepseek-ai/dsh'] */
  readonly command?: readonly string[]
  /** 追加的 --patch 覆盖层（可选） */
  readonly patches?: readonly string[]
  /** 单次超时毫秒，默认 180000（含 dsh 冷启动） */
  readonly timeoutMs?: number
}

function flatten(messages: readonly ChatMessage[]): string {
  // headless 只收一段提示词；把 system 约定与用户内容拼成一段
  return messages.map((m) => (m.role === 'system' ? `【必须遵守的任务要求】\n${m.content}` : m.content)).join('\n\n')
}

/** 创建 DSH headless 客户端。 */
export function createDshHeadlessClient(config: DshHeadlessConfig = {}): ChatClient {
  const command = config.command ?? ['npx', '-y', '@deepseek-ai/dsh']
  const timeoutMs = config.timeoutMs ?? 180_000
  const patchArgs = (config.patches ?? []).flatMap((p) => ['--patch', p])

  return {
    async chat(messages) {
      const [bin, ...baseArgs] = command
      if (bin === undefined) throw new Error('dsh headless command 为空')
      const args = [...baseArgs, ...patchArgs, '--profile', 'headless', flatten(messages)]
      const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
      const text = stdout.trim()
      if (text === '') throw new Error('dsh headless 没有输出')
      return text
    },
  }
}
