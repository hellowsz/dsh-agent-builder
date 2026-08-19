#!/usr/bin/env node
/**
 * 启动网页向导。模型通道:有 DEEPSEEK_API_KEY 直连,否则回落 dsh headless。
 * 目录/端口/插件路径可用环境变量覆盖,便于服务器部署:
 *   PORT, AB_HOST, AB_SESSIONS_DIR, AB_OUT_DIR, AB_PLUGIN_PATH
 */
import { env, stdout } from 'node:process'
import { createDeepSeekClient, createDshHeadlessClient, type ChatClient } from '@dsh-agent-builder/evaluator'
import { createWebuiServer, type WebuiOptions } from './server.js'

const apiKey = env.DEEPSEEK_API_KEY ?? ''
const makeClient = (): ChatClient => (apiKey !== '' ? createDeepSeekClient({ apiKey }) : createDshHeadlessClient())

const port = Number.parseInt(env.PORT ?? '4173', 10)
const host = env.AB_HOST ?? '127.0.0.1'

const opts: WebuiOptions = {
  workClient: makeClient(),
  reviewClient: makeClient(),
  ...(env.AB_SESSIONS_DIR !== undefined ? { sessionsDir: env.AB_SESSIONS_DIR } : {}),
  ...(env.AB_OUT_DIR !== undefined ? { outDir: env.AB_OUT_DIR } : {}),
  ...(env.AB_PLUGIN_PATH !== undefined ? { pluginPath: env.AB_PLUGIN_PATH } : {}),
}
const server = createWebuiServer(opts)

server.listen(port, host, () => {
  stdout.write(`模型通道:${apiKey !== '' ? 'DeepSeek 直连' : 'dsh headless'}\n`)
  stdout.write(`agent-builder 已启动:http://${host}:${port}\n`)
})
