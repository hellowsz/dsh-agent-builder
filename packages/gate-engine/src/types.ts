/**
 * 门禁引擎的核心类型：声明式门禁定义 + 执行输入输出。
 * 所有类型只读；引擎只读不改产出。
 */

/** 门禁层：structural=①结构 rule=②规则 grounding=③对照。④AI 评审由独立评审 agent 承担，见 aiReview 字段。 */
export type Layer = 'structural' | 'rule' | 'grounding'

/** 比较操作符（compare 检查用）。 */
export type CompareOp = '<=' | '<' | '>=' | '>' | '=='

interface CheckBase {
  /** 唯一 id，同时就是失败时的问题码 */
  readonly id: string
  /** 失败时给人看的说明（可含 {value} 占位，运行时替换为字段值），也用于喂回 agent */
  readonly message?: string
  /** 依赖的检查 id：任一未通过（失败或被跳过）则本检查跳过，避免重复/递进报错 */
  readonly dependsOn?: readonly string[]
}

/** ① 字段非空字符串。 */
export interface RequiredCheck extends CheckBase {
  readonly type: 'required'
  readonly field: string
}

/** ① 字段是有限数字，可限最小/最大（min/max 为闭边界，exclusiveMin 为开下界）。 */
export interface NumberCheck extends CheckBase {
  readonly type: 'number'
  readonly field: string
  readonly min?: number
  readonly exclusiveMin?: number
  readonly max?: number
}

/** ① 字段是合法 YYYY-MM-DD 日期。 */
export interface DateCheck extends CheckBase {
  readonly type: 'date'
  readonly field: string
}

/** ① 字段值必须在给定集合内。 */
export interface EnumCheck extends CheckBase {
  readonly type: 'enum'
  readonly field: string
  readonly values: readonly string[]
}

/** ② 两字段数值比较：left op right*factor（factor 缺省 1）。任一操作数非有限数字则跳过。 */
export interface CompareCheck extends CheckBase {
  readonly type: 'compare'
  readonly left: string
  readonly op: CompareOp
  readonly right: string
  readonly factor?: number
}

/** ② 日期字段不得晚于 today。日期非法则跳过（由 ① 报）。 */
export interface NotFutureCheck extends CheckBase {
  readonly type: 'not-future'
  readonly field: string
}

/** ③ 字段数值必须能在原文里找到（按数字分词，防把长号码误当金额）。 */
export interface NumberGroundedCheck extends CheckBase {
  readonly type: 'number-grounded'
  readonly field: string
}

/** ③ 字段文本必须在原文里出现。 */
export interface TextGroundedCheck extends CheckBase {
  readonly type: 'text-grounded'
  readonly field: string
}

/** ③ 字段日期必须能在原文抽出的日期集合里找到（支持中文/ISO 写法）。 */
export interface DateGroundedCheck extends CheckBase {
  readonly type: 'date-grounded'
  readonly field: string
}

export type StructuralCheckDef = RequiredCheck | NumberCheck | DateCheck | EnumCheck
export type RuleCheckDef = CompareCheck | NotFutureCheck
export type GroundingCheckDef = NumberGroundedCheck | TextGroundedCheck | DateGroundedCheck
export type CheckDef = StructuralCheckDef | RuleCheckDef | GroundingCheckDef

/** ④ AI 评审条目：由独立评审 agent 执行的软判断，引擎只声明不执行。 */
export interface AiReviewItem {
  readonly id: string
  /** 让评审 agent 判断的标准，自然语言 */
  readonly criteria: string
}

/** 一份完整的门禁定义（一 agent 一份）。 */
export interface GateDefinition {
  readonly version: 1
  /** 门禁名（通常等于 agent 名） */
  readonly name: string
  readonly description?: string
  readonly checks: readonly CheckDef[]
  readonly aiReview?: readonly AiReviewItem[]
}

/** 一次执行的输入。 */
export interface GateInput {
  /** 待验收的结构化产出 */
  readonly record: Readonly<Record<string, unknown>>
  /** 原始输入文字（③ 对照用；没有则 grounding 检查跳过） */
  readonly source?: string
  /** 今天 YYYY-MM-DD（② not-future 用；外部注入保证可重复） */
  readonly today?: string
}

/** 命中的一条问题。 */
export interface CheckIssue {
  readonly layer: Layer
  readonly field: string
  /** 即检查的 id */
  readonly code: string
  readonly message: string
}

/** 一次裁决。pendingAiReview 是需要评审 agent 接手的 ④ 条目。 */
export interface GateVerdict {
  readonly passed: boolean
  readonly issues: readonly CheckIssue[]
  readonly pendingAiReview: readonly AiReviewItem[]
}
