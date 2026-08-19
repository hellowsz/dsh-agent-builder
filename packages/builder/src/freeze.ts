/**
 * 固化：把一份通过验证的规格落成产物目录。
 * 产物：门禁文件、工作提示词、DSH preset、任务规格、稳定性报告。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeCandidate } from './candidate.js'
import { type PresetOptions } from './preset.js'
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
  writeCandidate(spec, dir, { pluginPath: presetOptions.pluginPath, maxRetries: presetOptions.maxRetries })
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2))
  writeFileSync(join(dir, 'report.md'), renderReport(spec, report))
  return {
    dir,
    files: [`${spec.name}.gate.yaml`, `${spec.name}.prompt.md`, `${spec.name}.preset.yaml`, 'spec.json', 'report.md'],
  }
}
