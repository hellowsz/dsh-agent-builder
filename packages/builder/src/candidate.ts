/**
 * 候选配置:设计阶段的产物(gate/prompt/preset 三件),写盘供 DeepSeek Harness 挂载执行。
 * 设计与执行分离的物理形态——agent builder 只产这份配置,拼装由 DSH 拿着它去干。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveGateYaml } from './derive.js'
import { deriveWorkPrompt } from './prompt.js'
import { derivePresetYaml, type PresetOptions } from './preset.js'
import { type TaskSpec } from './spec.js'

export interface CandidatePaths {
  readonly dir: string
  readonly gateFile: string
  readonly promptFile: string
  readonly presetFile: string
}

/** 把一份规格落成候选配置目录。 */
export function writeCandidate(spec: TaskSpec, dir: string, options: Omit<PresetOptions, 'gateFilePath' | 'promptFilePath'> & { readonly feedbackFilePath?: string }): CandidatePaths {
  mkdirSync(dir, { recursive: true })
  const gateFile = join(dir, `${spec.name}.gate.yaml`)
  const promptFile = join(dir, `${spec.name}.prompt.md`)
  const presetFile = join(dir, `${spec.name}.preset.yaml`)
  writeFileSync(gateFile, deriveGateYaml(spec))
  writeFileSync(promptFile, deriveWorkPrompt(spec))
  writeFileSync(presetFile, derivePresetYaml(spec, { ...options, gateFilePath: gateFile, promptFilePath: promptFile }))
  return { dir, gateFile, promptFile, presetFile }
}
