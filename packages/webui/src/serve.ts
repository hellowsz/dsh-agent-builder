#!/usr/bin/env node
/**
 * 启动网页向导。模型通道与 CLI 同策略:有 DEEPSEEK_API_KEY 直连,否则回落本机 dsh headless。
 * 只监听 127.0.0.1;端口取 PORT 环境变量,默认 4173。
 */
import { env, stdout } from 'node:process'
import { createDeepSeekClient, createDshHeadlessClient, type ChatClient } from '@dsh-agent-builder/evaluator'
import { createWebuiServer } from './server.js'

const apiKey = env.DEEPSEEK_API_KEY ?? ''
const makeClient = (): ChatClient => (apiKey !== '' ? createDeepSeekClient({ apiKey }) : createDshHeadlessClient())

const port = Number.parseInt(env.PORT ?? '4173', 10)
const server = createWebuiServer({ workClient: makeClient(), reviewClient: makeClient() })

server.listen(port, '127.0.0.1', () => {
  stdout.write(`模型通道:${apiKey !== '' ? 'DeepSeek 直连' : '本机 dsh headless(每步约 1-2 分钟,页面会提示)'}\n`)
  stdout.write(`网页向导已启动:http://127.0.0.1:${port}\n`)
})
