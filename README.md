# dsh-agent-builder

让不懂技术的人,用一段对话搭出一个**能稳定交付结果**的 agent。

产物是一份 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）配置:声明式**验证门禁** + 工作提示词 + cordis preset。固化后加载进 DSH 运行——每次产出都先过门禁,不合格自动打回重做,重试用尽则诚实报告,绝不静默交付错的结果。

## 为什么

AI agent 的老毛病:同样的输入,今天对、明天错。会编数字、编编号,而使用者恰恰没能力发现"这次是碰巧对了"。

本项目的答案是**验证门禁**:每个 agent 固化时都配一份自己的门禁,交付前逐层验收——

| 层 | 检查 | 手段 |
|---|---|---|
| ① 结构 | 格式、字段、类型、取值集合 | 确定性规则 |
| ② 规则 | 业务硬约束(税额≤金额、日期不晚于今天) | 确定性规则 |
| ③ 对照 | 数字/编号/日期必须在原文找得到依据——**防编造、防改数** | 确定性规则 |
| ④ AI 评审 | 归类合理性等软判断 | 独立评审 agent,拿不准判不过 |

能用确定性规则判的绝不靠 AI;④ 只兜前三层管不到的底。

## 架构:设计与执行严格分离

```
┌─ agent builder(设计侧,两个能力)──────────────┐
│ ①设计:大白话需求 → 拼接说明书(spec/门禁/提示词/preset) │
│ ②评审:DSH 拼出来的产物 → 门禁复核 + ④独立评审          │
└──────────┬────────────────▲─────────────┘
     候选配置 │                  │ 产物
            ▼                  │
┌─ DeepSeek Harness(执行侧)─────┴─────────────┐
│ 挂载候选配置拼装:模型干活,门禁插件在 DSH 内实时把关     │
└───────────────────────────────────────────┘

用户只做三次判断:确认说明书 → 评估产物 → 定稿。
定稿进「用户资产库」:一份能持续交付的 harness 配置,一键挂进 DSH 使用。
```

## 怎么用(双模式,共享同一任务库与资产库)

```sh
pnpm install
pnpm --filter @dsh-agent-builder/gate-plugin build   # 首次:构建门禁插件

# 模式一:网页向导(面向小白)——打开 http://127.0.0.1:4173
pnpm --filter @dsh-agent-builder/webui serve

# 模式二:专业 CLI(同一批任务/资产,终端里走完全程)
pnpm --filter @dsh-agent-builder/builder cli
```

模型通道二选一:设 `DEEPSEEK_API_KEY` 走 DeepSeek 直连;不设则自动回落本机 `dsh --profile headless`(凭证留在 dsh 里,每步约 1 分钟)。

流程:说需求 → 确认拼接说明书 → **AI 自造样例,候选配置交真 DSH 拼装,产物回 builder 评审** → 你评估产物(可提意见触发说明书修订+重探索,可补充真实样例)→ 定稿进资产库 → 一键启动使用。任务持久化在 `sessions/`,随时新建/恢复,网页与 CLI 可互相接续。

定稿资产在 `agents/<name>/`(五件套:门禁/提示词/preset/规格/报告),一键使用:

```sh
npx -y @deepseek-ai/dsh --patch agents/<name>/<name>.preset.yaml --profile web --port 3080
```

运行时,门禁插件挂在 DSH 的 `agent/turn-stopping` 扩展点,**四层全部生效**:确定性三层不过 → `agent.steer()` 喂回具体问题重开回合;三层过了再交**独立评审 agent**(dsh headless 子进程,独立会话)做 ④ 软判断,不过同样打回;重试限次防死锁,评审预算耗尽诚实告警放行。

## 仓库结构

```
packages/
  webui/          面向纯新手的网页向导(零框架单页,只绑 127.0.0.1)
  gate-engine/    通用门禁引擎:声明式门禁文件(一 agent 一份)+ 确定性执行器
  gate-plugin/    DSH 运行时插件:turn-stopping 拦截 + steer 重试限次(esbuild 单文件部署)
  evaluator/      ④ 独立评审 agent(DeepSeek API;缺结论=评审失败,绝不静默放行)
  builder/        对话式搭建助手:聊需求→生成门禁/提示词/preset→跑样例出报告→固化
  collector/      开源插件收集器:多查询检索→机械筛选→面向 AI 的清单(全部标"待核实")
examples/
  reimbursement-reference/   报销门禁的手写"标准答案"+ 声明式门禁 + 等价性测试
plugin-registry/
  catalog.yaml    收集器产出的插件清单
docs/             设计文档(定位、门禁设计、MVP 规格)
```

## 设计原则

- **两种稳定分开**:配置(yml)保证"接线稳定"——装配是确定性路径;门禁保证"内容稳定"——产出逐次验收。
- **门禁本身也要被验**:固化前拿好样例 + 故意弄坏的样例各跑一遍,好的必须过、坏的必须拦。
- **诚实失败**:重试用尽不静默降级,给出降级选项让人选。
- **收集≠可信**:插件清单只做机械筛选,一律标"待核实",接入前必须核验。

## 开发

```sh
pnpm install
pnpm -r test          # 全部测试(真 API 集成测试需 DEEPSEEK_API_KEY,缺省跳过)
```

## License

MIT
