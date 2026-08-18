/**
 * 真模型全链路验证（走本机 dsh headless，DeepSeek 凭证留在 dsh 里）。
 * ① evaluator：独立评审放行合理产出、拦下胡归类
 * ② builder 端到端：真起草规格 → 真工作 agent 抽发票 → 门禁+评审 → 报告 → 固化五件套
 * 全部通过输出 ALL-REAL-CHECKS-PASSED；任一失败退出码非 0。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exit, stdout } from 'node:process'
import { createDshHeadlessClient, review } from '@dsh-agent-builder/evaluator'
import { deriveGate, draftSpec, freeze, renderReport, runStability, validateSpec } from '@dsh-agent-builder/builder'

const client = createDshHeadlessClient()
let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  stdout.write(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures++
}

function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------- ① evaluator 真评审 ----------
stdout.write('\n== ① evaluator 独立评审（真模型） ==\n')
const REVIEW_ITEMS = [
  { id: 'category_sensible', criteria: '类别归类与费用项目、商户信息是否相符' },
  { id: 'note_sensible', criteria: '备注是否如实概括了商户/场景，没有编造信息' },
]
const SRC = '上海老盛昌汤包馆 2026年8月12日 电子发票 金额 428.00 元 餐饮服务'

const approve = await review(client, { source: SRC, record: { category: '餐饮', note: '上海老盛昌汤包馆' }, items: REVIEW_ITEMS })
check('合理产出放行', approve.error === undefined && approve.passed, approve.error ?? approve.findings.map((f) => `${f.id}:${f.passed}`).join(','))

const reject = await review(client, { source: SRC, record: { category: '住宿', note: '与客户在北京希尔顿酒店洽谈住宿' }, items: REVIEW_ITEMS })
check('胡归类+编造备注拦下', reject.error === undefined && !reject.passed, reject.error ?? reject.findings.filter((f) => !f.passed).map((f) => f.id).join(','))

// ---------- ② builder 端到端 ----------
stdout.write('\n== ② builder 端到端（真起草+真抽取+门禁+评审+固化） ==\n')
const spec = await draftSpec(
  client,
  '我想要一个报销整理助手:我把发票文字贴给它,它帮我整理出费用项目、金额(含税)、税额、开票日期、发票号、类别(餐饮/交通/住宿/办公/其他)。金额日期发票号不能编,税额不能大于金额。',
)
check('真起草规格合法', validateSpec(spec).length === 0, `${spec.name}: ${spec.fields.map((f) => f.name).join(',')}`)

const gate = deriveGate(spec)
const report = await runStability(
  spec,
  gate,
  [
    { name: '真实发票文字', source: '上海老盛昌汤包馆 2026年8月12日 电子发票 号码 24317000000123456789 金额 428.00 元 税率 6% 税额 24.23 餐饮服务', expect: 'pass' },
    { name: '无关文字应拦', source: '今天天气不错，我们去公园散步吧。', expect: 'block' },
  ],
  { workClient: client, reviewClient: client, today: localToday() },
)
stdout.write(renderReport(spec, report) + '\n')
check('稳定性:真发票通过', report.results[0]?.ok === true, report.results[0]?.issues.join(','))
check('稳定性:无关文字被拦', report.results[1]?.ok === true, report.results[1]?.issues.join(','))

const out = mkdtempSync(join(tmpdir(), 'verify-freeze-'))
const frozen = freeze(spec, report, out, {
  pluginPath: join(out, 'gate-plugin.mjs'),
  gateFilePath: join(out, spec.name, `${spec.name}.gate.yaml`),
})
check('固化五件套落盘', frozen.files.length === 5 && frozen.files.every((f) => existsSync(join(frozen.dir, f))), frozen.dir)
check('固化报告可读', readFileSync(join(frozen.dir, 'report.md'), 'utf8').includes('稳定性报告'))

stdout.write(failures === 0 ? '\nALL-REAL-CHECKS-PASSED\n' : `\n${failures} 项失败\n`)
exit(failures === 0 ? 0 : 1)
