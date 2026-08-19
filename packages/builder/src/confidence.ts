/**
 * 信心分级:资产的稳定性证据强度,诚实分档。
 * 🥉 bronze:仅合成样例验证通过(出厂级)
 * 🥈 silver:含网络素材/用户真实样例的验证通过
 * 🥇 gold:silver 基础上,线上运行近期 N 次零拦截
 * none:最新验证未全部符合预期(不配发牌)
 */
import { type Sample, type StabilityReport } from './stability.js'

export type ConfidenceTier = 'none' | 'bronze' | 'silver' | 'gold'

/** 达到 gold 需要的近期线上零拦截次数。 */
export const GOLD_RUNTIME_STREAK = 10

export interface RuntimeEvidence {
  /** 线上最近连续零拦截(通过)次数 */
  readonly cleanStreak: number
  /** 线上累计拦截(最终未过)次数 */
  readonly blockedTotal: number
}

/** 依据样例集与最新报告(及可选线上证据)评定信心等级。 */
export function tierOf(
  samples: readonly Sample[] | undefined,
  report: StabilityReport | undefined,
  runtime?: RuntimeEvidence,
): ConfidenceTier {
  if (report === undefined || report.total === 0 || report.matchRate < 1) return 'none'
  const hasStrong = (samples ?? []).some((s) => s.origin === 'web' || s.origin === 'real' || s.origin === 'runtime')
  if (!hasStrong) return 'bronze'
  if (runtime !== undefined && runtime.cleanStreak >= GOLD_RUNTIME_STREAK) return 'gold'
  return 'silver'
}

export const TIER_LABEL: Record<ConfidenceTier, string> = {
  none: '未达标',
  bronze: '🥉 合成样例验证',
  silver: '🥈 真实素材验证',
  gold: '🥇 线上实证',
}

/** 回归样例集合并:同原文去重,新样例进集,历史不丢。 */
export function mergeSampleBank(
  bank: readonly Sample[] | undefined,
  incoming: readonly Sample[],
): Sample[] {
  const seen = new Set((bank ?? []).map((s) => s.source.trim()))
  const merged = [...(bank ?? [])]
  for (const s of incoming) {
    const key = s.source.trim()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(s)
  }
  return merged
}
