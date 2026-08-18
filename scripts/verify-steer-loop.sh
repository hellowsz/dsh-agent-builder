#!/usr/bin/env bash
# steer 闭环实测（真 DSH + 真模型）。
# 原理:门禁要求一个暗号字段,其合法取值只通过失败反馈告知模型——
# 最终输出出现暗号 ⇔ "拦截→steer→模型改→放行"闭环真实发生。
# 前提:本机 dsh 已配好模型凭证;先 pnpm --filter @dsh-agent-builder/gate-plugin build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$ROOT/packages/gate-plugin/dist/gate-plugin.mjs" "$WORK/"

cat > "$WORK/steer.gate.yaml" <<'EOF'
version: 1
name: steer-loop-probe
checks:
  - { id: amount_invalid, type: number, field: amount, exclusiveMin: 0, message: amount 必须是大于 0 的数字 }
  - id: confirmation_missing
    type: enum
    field: confirmation
    values: [GATE-OK-9527]
    message: "输出的 JSON 里必须包含字段 confirmation，取值必须是字符串 GATE-OK-9527"
EOF

cat > "$WORK/steer.preset.yaml" <<EOF
- insert:
    - id: gate-steer-probe
      name: '$WORK/gate-plugin.mjs'
      config:
        gateFile: '$WORK/steer.gate.yaml'
        maxRetries: 2
EOF

OUT="$(npx -y @deepseek-ai/dsh --patch "$WORK/steer.preset.yaml" --profile headless \
  "把这条报销信息整理成 JSON 输出(放在 json 围栏里,只含 amount 数字字段):午餐费 428 元")"

echo "$OUT"
if grep -q "GATE-OK-9527" <<< "$OUT"; then
  echo "STEER-LOOP-VERIFIED"
else
  echo "steer 闭环未发生:输出里没有暗号" >&2
  exit 1
fi
