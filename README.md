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

## 怎么用

```sh
pnpm install
export DEEPSEEK_API_KEY=sk-...

# 对话式搭建：描述任务 → 确认规格 → 贴样例 → 看稳定性报告 → 固化
pnpm --filter @dsh-agent-builder/builder cli
```

固化产物在 `agents/<name>/`:门禁(`*.gate.yaml`)、提示词(`*.prompt.md`)、DSH preset(`*.preset.yaml`)、规格与稳定性报告。在 DSH 里使用:

```sh
pnpm --filter @dsh-agent-builder/gate-plugin build   # 产出自包含 dist/gate-plugin.mjs
dsh --patch agents/<name>/<name>.preset.yaml web
```

运行时,门禁插件挂在 DSH 的 `agent/turn-stopping` 扩展点:产出不合格 → `agent.steer()` 喂回具体问题重开回合(限次防死循环);合格才放行。

## 仓库结构

```
packages/
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
