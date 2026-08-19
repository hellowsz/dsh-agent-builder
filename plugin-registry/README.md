# plugin-registry(已独立成仓库)

插件生态收集器**已拆分为独立仓库**:https://github.com/hellowsz/dsh-plugin-registry

原因(见 vision.md 定稿):生态仓库依赖 DeepSeek Harness、与产品主仓解耦,只通过 `catalog.yaml` 一个文件做接口——独立仓库生产,本主仓消费(见 `packages/builder/src/plugin-catalog.ts`)。

- 每日 systemd timer 自动收集,产出面向 AI 检索的清单
- 本目录 `catalog.yaml` 是一份历史快照;线上以独立仓库部署的每日清单为准(服务器 `/opt/agent-builder/data/plugin-catalog.yaml`)
