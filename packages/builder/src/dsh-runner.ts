/**
 * DSH 执行通道:把候选配置挂进真 DeepSeek Harness(headless),喂样例原文,拿回产物。
 * 这是"设计与执行分离"的执行侧——builder 不自己拼,拼装发生在 DSH 里(含门禁 steer 闭环)。
 *
 * 文件交付物:每个样例给独立工作目录,DSH 在里面产出的文件(PPT/文档等)执行完收集返回,
 * 供用户查看下载——看不到产物就没法评估,这是评审的前提。
 * 传输容错:DeepSeek API 偶发 TRANSPORT 失败(常见于代理拦截),自动重试。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { type ProducedFile, type ProducedOutput, type Sample } from './stability.js'

const execFileAsync = promisify(execFile)

export interface DshProducerConfig {
  /** 候选配置的 preset 文件(cordis patch)绝对路径 */
  readonly presetFile: string
  /** 样例运行目录根:每个样例一个子目录作为 DSH 工作目录,产出文件从中收集。缺省不收集文件 */
  readonly runsDir?: string
  /** dsh 可执行方式,默认 ['npx','-y','@deepseek-ai/dsh'] */
  readonly command?: readonly string[]
  /** 单样例超时毫秒,默认 300000(含 dsh 冷启动与门禁重试) */
  readonly timeoutMs?: number
  /** 传输类失败重试次数,默认 2 */
  readonly retries?: number
}

/** 样例名转安全目录名。 */
function safeDirName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_-]+/gu, '_')
}

/** 递归收集目录下的文件(跳过隐藏与 node_modules)。 */
export function collectFiles(dir: string, base = dir): ProducedFile[] {
  const out: ProducedFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectFiles(full, base))
    else {
      const st = statSync(full)
      out.push({ name: relative(base, full), path: full, bytes: st.size })
    }
  }
  return out
}

/** 造一个"经真 DSH 生产产物"的函数:样例原文进,DSH 最终答复+产出文件出。 */
export function createDshProducer(config: DshProducerConfig): (sample: Sample) => Promise<ProducedOutput> {
  const command = config.command ?? ['npx', '-y', '@deepseek-ai/dsh']
  const timeoutMs = config.timeoutMs ?? 300_000
  const retries = config.retries ?? 2

  return async (sample) => {
    const [bin, ...baseArgs] = command
    if (bin === undefined) throw new Error('dsh command 为空')

    let cwd: string | undefined
    if (config.runsDir !== undefined) {
      cwd = join(config.runsDir, safeDirName(sample.name))
      mkdirSync(cwd, { recursive: true })
    }

    const args = [...baseArgs, '--patch', config.presetFile, '--profile', 'headless', sample.source]
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { stdout } = await execFileAsync(bin, args, {
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          ...(cwd !== undefined ? { cwd } : {}),
        })
        const answer = stdout.trim()
        if (answer === '') throw new Error('DSH 没有输出')
        const files = cwd !== undefined ? collectFiles(cwd) : undefined
        return { answer, ...(files !== undefined && files.length > 0 ? { files } : {}) }
      } catch (e) {
        lastError = e
        // 传输类偶发失败(如代理拦截 DeepSeek API)重试;最后一次失败才抛
      }
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`DSH 执行失败(已重试 ${retries} 次):${msg.slice(0, 400)}`)
  }
}
