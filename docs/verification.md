# 验证记录

“稳定交付”是本项目的承诺,所以验证本身按同样标准执行:每个组件先过确定性测试,再过真环境/真模型验证。本文是完整的验证矩阵与复跑方式。

## 验证矩阵

| # | 验证项 | 方式 | 结果 |
|---|---|---|---|
| 1 | 全仓单元测试(79 项) | `pnpm -r test` | ✅ 全绿 |
| 2 | 声明式门禁 ≡ 手写标准答案 | 等价性测试(examples/reimbursement-reference) | ✅ 好样例双放行、6 坏样例双拦截且问题码一致 |
| 3 | gate-plugin 单文件产物可加载 | `pnpm --filter gate-plugin build` + node import | ✅ 自包含 278KB |
| 4 | 插件收集器真跑 | `pnpm --filter collector collect` | ✅ 3 查询 → 56 条入 catalog.yaml |
| 5 | DSH 真运行时:preset 挂载+插件加载 | `dsh --patch preset --profile web` | ✅ 0 错误,Web UI HTTP 200 |
| 6 | **steer 打回闭环(真 DSH+真模型)** | `pnpm verify:steer`(暗号法,见下) | ✅ 输出含暗号 GATE-OK-9527 |
| 7 | ④ 独立评审真模型 | `pnpm verify:real` ① | ✅ 合理产出放行、胡归类+编造备注拦下（2026-08-18） |
| 8 | builder 端到端真跑 | `pnpm verify:real` ② | ✅ 真起草→真抽取→门禁+评审→固化，2/2 样例符合预期（2026-08-18） |
| 9 | **运行时 ④ 评审闭环(真 DSH+真模型+真评审子进程)** | `pnpm verify:review`(暗号法) | ✅ 输出含暗号 REVIEW-OK-7788（2026-08-18） |
| 10 | 提示词注入(preset promptFile → systemPrompt.section) | 真 DSH headless,只贴原文不贴提示词 | ✅ 输出含只存在于 prompt.md 的字段名 expense-item/invoice-no（2026-08-19） |

## 真环境验证抓出的问题（这就是要做真验证的原因）

1. **打包内联 `@deepseek-ai/dsh-llm` 崩溃**:其运行时 `require('../package.json')` 在自包含单文件里失效。修复:去掉该依赖,steer 消息同构自实现。
2. **CJS 依赖(yaml)在 ESM bundle 里 `Dynamic require of "process"`**:esbuild banner 注入 `createRequire` shim。
3. **`dsh web` 子命令不接受全局 `--patch`**:必须写成 `dsh --patch X --profile web`。

三个问题单元测试全部发现不了,只有真 DSH 加载才暴露。

## 真模型验证还抓出的两个 LLM 行为问题（已修）

4. **模型爱输出驼峰字段名**，重试劝不动 → 起草归一化确定性转 kebab-case（机械可修的问题不浪费 LLM 重试），已固化为回归测试。
5. **起草的比较规则方向会写反、可改写的描述字段不该做原文对照** → 起草提示词给出显式方向示例；`grounded` 标志开放给起草并透传（编号/金额/日期必须对照，可改写的描述类文字可关闭）。

另记：一次运行中出现过 ④ 评审输出解析失败（`review_failed`）的偶发，加固解析容错与提示词后未再复现——这类偶发恰是"多样例稳定性报告"机制要暴露的对象：固化前多跑样例，通过率如实呈现。

## steer 闭环的"暗号验证法"

如何证明"拦截→steer 打回→模型修正→放行"真的发生了,而不是模型一次就答对?

门禁里放一个**暗号字段**:`confirmation` 必须取值 `GATE-OK-9527`,而这个值只写在门禁的失败反馈消息里,提示词里绝不提。于是:

- 模型第一次输出必然没有该字段(它不知道)→ 门禁拦截 → steer 把要求喂回
- 最终输出**只有在消费了 steer 反馈后**才可能包含暗号

最终输出:`{"amount": 428, "confirmation": "GATE-OK-9527"}` —— 闭环铁证。

同法验证了**运行时 ④ 评审闭环**:暗号 `REVIEW-OK-7788` 只写在评审标准(aiReview criteria)里,确定性三层管不到它——最终输出含该暗号,证明"确定性过→评审拦→steer 评审理由→修正→复审放行"在真 DSH 里完整发生(评审由独立的 dsh headless 子进程执行)。

## 真模型验证通道

真模型调用通过 `createDshHeadlessClient` 走本机 `dsh --profile headless`(DeepSeek 凭证保存在 dsh 自己的凭证库,不经过本项目进程),或设置 `DEEPSEEK_API_KEY` 后走 `createDeepSeekClient` 直连。CI 缺省跳过真 API 测试,不影响绿灯。

## 复跑

```sh
pnpm -r test          # 1-2
pnpm --filter @dsh-agent-builder/gate-plugin build   # 3
pnpm --filter @dsh-agent-builder/collector collect   # 4
pnpm verify:steer     # 6（需本机 dsh 凭证）
pnpm verify:real      # 7-8（需本机 dsh 凭证）
pnpm verify:review    # 9（需本机 dsh 凭证）
```
