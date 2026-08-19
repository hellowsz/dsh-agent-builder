# 一站式服务上线方案(happysyy.com)

## 目标

把 agent-builder 作为 **happysyy.com 的主能力**,与服务器上已运行的 DeepSeek Harness 打通,提供"设计 agent → 拼装执行 → 评审 → 定稿 → 使用"的一站式服务。

## 现状盘点(复用,不重建)

- 香港 ECS `i-yest7rggsg6i82iy5pqq`,EIP 101.47.77.133,DNS zone 271905(www/@/dsh → EIP)
- nginx + Let's Encrypt 正式证书 + 登录墙(auth gate,cookie 版,`.happysyy.com` 子域共享)
- DeepSeek Harness 以 systemd 常驻(dsh web :3080,只听本机),nginx 反代
- 已有 preview 子域反代机制

## 目标形态

```
happysyy.com(主域)           → agent-builder 落地页 + 网页向导(新的主能力)
happysyy.com/api/*            → agent-builder 服务(node,只听本机 127.0.0.1:4173)
dsh.happysyy.com              → DeepSeek Harness(执行侧,已存在)
                                 用户定稿的 agent 一键启动后在这里用
```

一条 nginx 站点内:根路径给 agent-builder,`/dsh/` 前缀或 `dsh.happysyy.com` 给 Harness,全部在同一套登录墙后。

## 上线步骤(自动化脚本 scripts/deploy-hk.sh)

1. **本地构建**:`webui` 打成自包含产物(server.mjs 单文件 + static),`gate-plugin` 打成 dist/gate-plugin.mjs
2. **推送**:scp 产物到服务器 `/opt/agent-builder/`
3. **服务化**:systemd `agent-builder.service`(node server.mjs,PORT=4173,只听 127.0.0.1),DEEPSEEK_API_KEY 从服务器环境注入(服务器直连 DeepSeek 不经代理,规避本地 TUN 问题)
4. **nginx**:主域根路径反代 127.0.0.1:4173;SSE 端点关闭 buffering;沿用现有 auth gate 登录墙
5. **验证**:https://www.happysyy.com 出落地页;建任务→设计→(服务器本地 dsh headless)执行→评审→定稿→一键在 dsh.happysyy.com 使用

## 关键决策

- **执行通道**:服务器上 agent-builder 走服务器本机的 dsh headless(和本地开发一致的 createDshHeadlessClient),或直连 DeepSeek API(服务器网络直连,更快)。二选一由服务器环境变量决定。
- **数据目录**:sessions/ 与 agents/ 落在 `/opt/agent-builder/data/`,持久化。
- **安全**:服务只听 127.0.0.1,对外只经 nginx + 登录墙;API key 只在服务器环境,不进代码不进产物。
