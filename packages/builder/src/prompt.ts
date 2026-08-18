/**
 * 确定性推导：TaskSpec → 工作 agent 的系统提示词。
 * 纯模板，不走 LLM——同一规格永远生成同一提示词。
 */
import { type FieldSpec, type TaskSpec } from './spec.js'

function fieldLine(f: FieldSpec): string {
  const kindDesc: Record<FieldSpec['kind'], string> = {
    text: '文本',
    number: '数字（不带引号）',
    date: '日期，格式 YYYY-MM-DD',
    enum: `只能取：${(f.values ?? []).join(' / ')}`,
  }
  const opt = f.optional === true ? '（可空，抽不到就填 null）' : ''
  return `- "${f.name}"：${f.label}，${kindDesc[f.kind]}${opt}`
}

/** 生成工作 agent 的系统提示词。 */
export function deriveWorkPrompt(spec: TaskSpec): string {
  return [
    `你是「${spec.title}」。任务：${spec.description}`,
    '',
    '规则：',
    '1. 只依据用户提供的原文抽取信息，绝不编造、绝不改动数字和编号。',
    '2. 原文里找不到的必填信息，如实说明缺什么，不要瞎填。',
    '3. 最终结果必须放在一个 ```json 围栏里输出，字段如下：',
    ...spec.fields.map(fieldLine),
    '4. json 围栏外可以简短说明，但结论以围栏内 JSON 为准。',
  ].join('\n')
}
