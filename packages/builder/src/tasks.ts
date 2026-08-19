/**
 * 任务存储:一个"搭积木任务"= 一次完整的 agent 设计会话,一任务一 JSON 文件持久化。
 * 状态机:draft(说明书起草/待确认) → review(已确认,探索中/待产物评估) → frozen(说明书定稿)。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type Sample, type StabilityReport } from './stability.js'
import { type ConfidenceTier } from './confidence.js'
import { type TaskSpec } from './spec.js'

export type TaskStatus = 'draft' | 'review' | 'frozen'

export interface BuilderTask {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly status: TaskStatus
  /** 列表里显示的名字:起草前取描述截断,起草后取方案标题 */
  readonly title: string
  /** 用户最初的大白话描述 */
  readonly description: string
  readonly spec?: TaskSpec
  readonly samples?: readonly Sample[]
  readonly report?: StabilityReport
  /** 最新一次验证后的信心等级 */
  readonly tier?: ConfidenceTier
  readonly frozen?: { readonly dir: string; readonly files: readonly string[]; readonly dshCommand: string }
}

/** 列表条目(轻量)。 */
export interface TaskSummary {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly updatedAt: string
}

const FILE_RE = /^task-[0-9a-f-]+\.json$/

export class TaskStore {
  private readonly tasks = new Map<string, BuilderTask>()

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    for (const file of readdirSync(dir)) {
      if (!FILE_RE.test(file)) continue
      try {
        const task = JSON.parse(readFileSync(join(dir, file), 'utf8')) as BuilderTask
        if (typeof task.id === 'string' && typeof task.description === 'string') this.tasks.set(task.id, task)
      } catch {
        // 单个损坏文件不拖垮启动;留在磁盘上供人排查
      }
    }
  }

  list(): readonly TaskSummary[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, title, status, updatedAt }) => ({ id, title, status, updatedAt }))
  }

  get(id: string): BuilderTask {
    const task = this.tasks.get(id)
    if (task === undefined) throw new Error(`任务不存在:${id}`)
    return task
  }

  create(description: string): BuilderTask {
    const now = new Date().toISOString()
    const task: BuilderTask = {
      id: `task-${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      title: description.length > 18 ? `${description.slice(0, 18)}…` : description,
      description,
    }
    this.save(task)
    return task
  }

  /** 不可变更新:返回新对象并落盘。 */
  update(id: string, patch: Partial<Omit<BuilderTask, 'id' | 'createdAt'>>): BuilderTask {
    const next: BuilderTask = { ...this.get(id), ...patch, updatedAt: new Date().toISOString() }
    this.save(next)
    return next
  }

  private save(task: BuilderTask): void {
    this.tasks.set(task.id, task)
    writeFileSync(join(this.dir, `${task.id}.json`), JSON.stringify(task, null, 2))
  }
}
