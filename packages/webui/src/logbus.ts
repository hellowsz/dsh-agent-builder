/**
 * 日志总线:环形缓冲 + SSE 订阅广播。
 * 所有流程埋点走这里,前端实时看,也可整段回查。
 */
import { type ServerResponse } from 'node:http'

export type LogLevel = 'info' | 'ok' | 'warn' | 'err'

export interface LogEntry {
  readonly seq: number
  readonly ts: string
  readonly level: LogLevel
  /** 归属环节:sys/draft/llm/gate/review/verify/freeze */
  readonly tag: string
  readonly msg: string
  readonly data?: unknown
}

const MAX_ENTRIES = 800

export class LogBus {
  private readonly entries: LogEntry[] = []
  private readonly subscribers = new Set<ServerResponse>()
  private seq = 0

  log(level: LogLevel, tag: string, msg: string, data?: unknown): LogEntry {
    const entry: LogEntry = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      level, tag, msg,
      ...(data !== undefined ? { data } : {}),
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.shift()
    const payload = `data: ${JSON.stringify(entry)}\n\n`
    for (const res of this.subscribers) res.write(payload)
    return entry
  }

  history(): readonly LogEntry[] {
    return this.entries
  }

  /** 挂一个 SSE 订阅者:先补发历史,再持续推送。 */
  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    for (const entry of this.entries) res.write(`data: ${JSON.stringify(entry)}\n\n`)
    this.subscribers.add(res)
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
    res.on('close', () => {
      clearInterval(heartbeat)
      this.subscribers.delete(res)
    })
  }
}
