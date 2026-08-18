/**
 * 固化：把一份通过验证的规格落成产物目录。
 * 产物：门禁文件、工作提示词、DSH preset、任务规格、稳定性报告。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveGateYaml } from './derive.js'
import { deriveWorkPrompt } from './prompt.js'
import { derivePresetYaml, type PresetOptions } from './preset.js'
import { renderReport, type StabilityReport } from './stability.js'
import { type TaskSpec } from './spec.js'

export interface FreezeResult {
  readonly dir: string
  readonly files: readonly string[]
}

/** 固化到 outDir/<spec.name>/。返回写出的文件清单。 */
export function freeze(
  spec: TaskSpec,
  report: StabilityReport,
  outDir: string,
  presetOptions: PresetOptions,
): FreezeResult {
  const dir = join(outDir, spec.name)
  mkdirSync(dir, { recursive: true })

  const files: Array<[string, string]> = [
    [`${spec.name}.gate.yaml`, deriveGateYaml(spec)],
    [`${spec.name}.prompt.md`, deriveWorkPrompt(spec)],
    [`${spec.name}.preset.yaml`, derivePresetYaml(spec, presetOptions)],
    ['spec.json', JSON.stringify(spec, null, 2)],
    ['report.md', renderReport(spec, report)],
  ]
  for (const [name, content] of files) writeFileSync(join(dir, name), content)
  return { dir, files: files.map(([name]) => name) }
}
