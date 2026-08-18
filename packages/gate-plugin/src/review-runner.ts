/**
 * 运行时 ④ 评审通道。
 * 默认借 dsh headless 子进程当独立评审 agent——独立会话、密钥留在 dsh 凭证库。
 */
import {
  createDshHeadlessClient,
  review,
  type ReviewInput,
  type ReviewResult,
} from '@dsh-agent-builder/evaluator'

/** 评审执行器：输入产出与标准，给出裁决。 */
export type Reviewer = (input: ReviewInput) => Promise<ReviewResult>

export interface ReviewChannelConfig {
  /** 'headless'（默认，dsh 子进程）或 'off'（关闭 ④，仅确定性三层） */
  readonly reviewMode?: 'headless' | 'off'
  /** headless 命令，默认 ['npx','-y','@deepseek-ai/dsh'] */
  readonly reviewCommand?: readonly string[]
  /** 单次评审超时毫秒 */
  readonly reviewTimeoutMs?: number
}

/** 按配置建评审执行器；mode=off 返回 undefined。 */
export function createReviewer(config: ReviewChannelConfig): Reviewer | undefined {
  if (config.reviewMode === 'off') return undefined
  const client = createDshHeadlessClient({
    ...(config.reviewCommand !== undefined ? { command: config.reviewCommand } : {}),
    ...(config.reviewTimeoutMs !== undefined ? { timeoutMs: config.reviewTimeoutMs } : {}),
  })
  return (input) => review(client, input)
}
