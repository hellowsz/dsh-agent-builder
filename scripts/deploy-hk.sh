#!/usr/bin/env bash
# 把 agent-builder 部署到香港 ECS,作为 happysyy.com 主能力,与已运行的 DeepSeek Harness 结合。
# 前提:本机能 ssh root@$HOST(已注入公钥);服务器已有 nginx + 登录墙 + dsh(:3080)。
# 用法:HOST=101.47.77.133 bash scripts/deploy-hk.sh
set -euo pipefail

HOST="${HOST:-101.47.77.133}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/agent-builder
SSH="ssh -o StrictHostKeyChecking=no root@$HOST"

echo "== 1/6 本地构建产物 =="
cd "$ROOT"
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null
pnpm --filter @dsh-agent-builder/gate-plugin build
pnpm --filter @dsh-agent-builder/webui build

echo "== 2/6 打包 =="
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/dist" "$STAGE/static" "$STAGE/gate-plugin"
cp packages/webui/dist/server.mjs "$STAGE/dist/"
cp -r packages/webui/static/* "$STAGE/static/"
cp packages/gate-plugin/dist/gate-plugin.mjs "$STAGE/gate-plugin/"
tar -czf "$STAGE/bundle.tgz" -C "$STAGE" dist static gate-plugin

echo "== 3/6 推送到 $HOST =="
$SSH "mkdir -p $APP/data/sessions $APP/data/agents"
scp -o StrictHostKeyChecking=no "$STAGE/bundle.tgz" "root@$HOST:$APP/bundle.tgz"
$SSH "cd $APP && tar -xzf bundle.tgz && rm bundle.tgz"

echo "== 4/6 systemd 服务 =="
$SSH "cat > /etc/systemd/system/agent-builder.service" <<UNIT
[Unit]
Description=agent-builder web
After=network.target dsh.service

[Service]
Type=simple
Environment=PORT=4173
Environment=AB_HOST=127.0.0.1
Environment=AB_SESSIONS_DIR=$APP/data/sessions
Environment=AB_OUT_DIR=$APP/data/agents
Environment=AB_PLUGIN_PATH=$APP/gate-plugin/gate-plugin.mjs
# 服务器直连 DeepSeek(不经本地代理);如需改用本机 dsh headless 则删掉下一行
EnvironmentFile=-$APP/env
ExecStart=/usr/local/bin/node $APP/dist/server.mjs
WorkingDirectory=$APP
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
$SSH "systemctl daemon-reload && systemctl enable agent-builder && systemctl restart agent-builder"

echo "== 5/6 nginx 主域根路径反代 agent-builder =="
$SSH "bash -s" <<'NGINX'
set -e
CONF=$(grep -rl "server_name www.happysyy.com" /etc/nginx/ 2>/dev/null | head -1)
CONF=${CONF:-/etc/nginx/conf.d/happysyy.conf}
# 幂等:已插入过就跳过
if ! grep -q "location /app" "$CONF" 2>/dev/null; then
  echo "请手动确认 nginx 主 server 块内加入以下 location(脚本不自动改主配置以免破坏登录墙):"
fi
cat <<'SNIPPET'
# —— 加入 www.happysyy.com 的 server 块(登录墙 location 之内)——
location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
}
location /api/events {
    proxy_pass http://127.0.0.1:4173;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_http_version 1.1;
}
SNIPPET
NGINX

echo "== 6/6 完成 =="
echo "服务状态:"; $SSH "systemctl is-active agent-builder; curl -s -o /dev/null -w 'local:%{http_code}\n' http://127.0.0.1:4173/"
echo "如需服务器直连 DeepSeek,在服务器执行:echo 'DEEPSEEK_API_KEY=sk-xxx' > $APP/env && systemctl restart agent-builder"
echo "验证:打开 https://www.happysyy.com"
