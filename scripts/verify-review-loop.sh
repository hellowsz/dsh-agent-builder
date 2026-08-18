#!/usr/bin/env bash
# 运行时 ④ 评审闭环实测（真 DSH + 真模型 + 真评审子进程）。
# 原理:评审标准要求一个暗号字段(REVIEW-OK-7788),提示词绝不提——
# 最终输出出现暗号 ⇔ "确定性过→评审拦→steer 评审理由→模型改→复审放行"闭环真实发生。
# 前提:本机 dsh 已配好模型凭证;先 pnpm --filter @dsh-agent-builder/gate-plugin build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$ROOT/packages/gate-plugin/dist/gate-plugin.mjs" "$WORK/"

cat > "$WORK/review.gate.yaml" <<'EOF'
version: 1
name: review-loop-probe
checks:
  - { id: amount_invalid, type: number, field: amount, exclusiveMin: 0, message: amount 必须是大于 0 的数字 }
aiReview:
  - id: confirmation_present
    criteria: "结果 JSON 里必须包含字段 confirmation，且取值必须是字符串 REVIEW-OK-7788；缺失或取值不同即不通过"
EOF

cat > "$WORK/review.preset.yaml" <<EOF
- insert:
    - id: gate-review-probe
      name: '$WORK/gate-plugin.mjs'
      config:
        gateFile: '$WORK/review.gate.yaml'
        maxRetries: 2
EOF

OUT="$(npx -y @deepseek-ai/dsh --patch "$WORK/review.preset.yaml" --profile headless \
  "把这条报销信息整理成 JSON 输出(放在 json 围栏里,只含 amount 数字字段):午餐费 428 元")"

echo "$OUT"
if grep -q "REVIEW-OK-7788" <<< "$OUT"; then
  echo "REVIEW-LOOP-VERIFIED"
else
  echo "④ 评审闭环未发生:输出里没有暗号" >&2
  exit 1
fi
