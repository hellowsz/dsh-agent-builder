/**
 * 确定性推导：TaskSpec → DSH cordis patch（preset）YAML。
 * 固化产物之一：把 gate-plugin 和该 agent 的门禁文件挂进 DSH。
 */
import { stringify } from 'yaml'
import { type TaskSpec } from './spec.js'

export interface PresetOptions {
  /** gate-plugin 打包产物（单文件 .mjs）的绝对路径 */
  readonly pluginPath: string
  /** 门禁文件的绝对路径 */
  readonly gateFilePath: string
  /** 工作提示词文件的绝对路径(注入为部署 persona,一条命令即可用) */
  readonly promptFilePath?: string
  /** steer 重试上限，默认 2 */
  readonly maxRetries?: number
}

/** 生成 cordis patch YAML：insert gate-plugin，配置指向该 agent 的门禁文件。 */
export function derivePresetYaml(spec: TaskSpec, options: PresetOptions): string {
  return stringify([
    {
      insert: [
        {
          id: `gate-${spec.name}`,
          name: options.pluginPath,
          config: {
            gateFile: options.gateFilePath,
            ...(options.promptFilePath !== undefined ? { promptFile: options.promptFilePath } : {}),
            maxRetries: options.maxRetries ?? 2,
          },
        },
      ],
    },
  ])
}
