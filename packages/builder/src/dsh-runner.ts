/**
 * DSH 执行通道:把候选配置挂进真 DeepSeek Harness(headless),喂样例原文,拿回产物。
 * 这是"设计与执行分离"的执行侧——builder 不自己拼,拼装发生在 DSH 里(含门禁 steer 闭环)。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type Sample } from './stability.js'

const execFileAsync = promisify(execFile)

export interface DshProducerConfig {
  /** 候选配置的 preset 文件(cordis patch)绝对路径 */
  readonly presetFile: string
  /** dsh 可执行方式,默认 ['npx','-y','@deepseek-ai/dsh'] */
  readonly command?: readonly string[]
  /** 单样例超时毫秒,默认 300000(含 dsh 冷启动与门禁重试) */
  readonly timeoutMs?: number
}

/** 造一个"经真 DSH 生产产物"的函数:样例原文进,DSH 最终答复出。 */
export function createDshProducer(config: DshProducerConfig): (sample: Sample) => Promise<string> {
  const command = config.command ?? ['npx', '-y', '@deepseek-ai/dsh']
  const timeoutMs = config.timeoutMs ?? 300_000

  return async (sample) => {
    const [bin, ...baseArgs] = command
    if (bin === undefined) throw new Error('dsh command 为空')
    const args = [...baseArgs, '--patch', config.presetFile, '--profile', 'headless', sample.source]
    const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    const text = stdout.trim()
    if (text === '') throw new Error('DSH 没有输出')
    return text
  }
}
