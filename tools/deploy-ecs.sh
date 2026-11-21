#!/usr/bin/env bash
# deploy-ecs.sh —— 阿里云 ECS 一键部署 VisInter-Agent 云端后端
#
# 用法（在 ECS 上以 root 执行）：
#   bash deploy-ecs.sh
#
# 前置：把 avp-deploy.zip 上传到 /root/（scp 或控制台文件上传）
#   scp avp-deploy.zip root@<公网IP>:/root/
#
# 做完的事：装 Node22 + ffmpeg → 解压代码 → 写 systemd 服务 → 开机自启 → 开防火墙
set -euo pipefail

APP_DIR=/opt/avp
DATA_DIR=/var/lib/avp
ZIP=${1:-/root/avp-deploy.zip}

# ── 你的 Key（改这里，或用环境变量传入）────────────────
: "${DASHSCOPE_API_KEY:?请先 export DASHSCOPE_API_KEY=sk-ws-...}"
DASHSCOPE_API=${DASHSCOPE_API:-https://cn-beijing.maas.qianwenaiapi.com}
ADMIN_TOKEN=${ADMIN_TOKEN:-avp_$(head -c 16 /dev/urandom | xxd -p)}
PORT=${PORT:-8787}

echo "=============================================="
echo " VisInter-Agent 云端后端部署"
echo " 端口 $PORT　数据 $DATA_DIR"
echo "=============================================="

# ── 1. 系统依赖 ────────────────────────────────
if ! command -v node >/dev/null || [ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 22 ]; then
  echo "[1/6] 安装 Node.js 22 ..."
  curl -fsSL https://rpm.nodesource.com/setup_22.x 2>/dev/null | bash - 2>/dev/null || \
  curl -fsSL https://deb.nodesource.com/setup_22.x 2>/dev/null | bash - 2>/dev/null || true
  if command -v apt-get >/dev/null; then
    apt-get update -qq && apt-get install -y -qq nodejs ffmpeg unzip curl
  elif command -v yum >/dev/null; then
    yum install -y -q nodejs ffmpeg unzip curl
  fi
fi
command -v node >/dev/null || { echo "Node 安装失败"; exit 1; }
echo "  Node $(node -v)"

if ! command -v ffmpeg >/dev/null; then
  echo "[1/6] 安装 ffmpeg ..."
  (command -v apt-get >/dev/null && apt-get install -y -qq ffmpeg) || \
  (command -v yum >/dev/null && yum install -y -q ffmpeg) || echo "  ⚠ ffmpeg 装不上，后处理会不可用"
fi
echo "  ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3 || echo '未装')"

# ── 2. 解压代码 ────────────────────────────────
echo "[2/6] 部署代码到 $APP_DIR ..."
mkdir -p "$APP_DIR" "$DATA_DIR"
if [ -f "$ZIP" ]; then
  rm -rf "$APP_DIR"/* 
  unzip -qo "$ZIP" -d "$APP_DIR"
  echo "  已从 $ZIP 解压"
elif [ -d /root/visinter-agent ]; then
  cp -r /root/visinter-agent/* "$APP_DIR"/
  echo "  已从 /root/visinter-agent 复制"
else
  echo "  ✗ 找不到代码包：请把 avp-deploy.zip 放到 $ZIP"
  exit 1
fi
[ -f "$APP_DIR/cloud/server.mjs" ] || { echo "  ✗ 代码结构不对，缺 cloud/server.mjs"; exit 1; }

# ── 3. 写 systemd 服务 ─────────────────────────
echo "[3/6] 配置 systemd（开机自启 + 崩溃重启）..."
cat > /etc/systemd/system/avp-cloud.service <<EOF
[Unit]
Description=VisInter-Agent Cloud Backend
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
Environment=ADMIN_TOKEN=$ADMIN_TOKEN
Environment=DASHSCOPE_API_KEY=$DASHSCOPE_API_KEY
Environment=DASHSCOPE_API=$DASHSCOPE_API
Environment=AVP_VIDEO_PROVIDER=wanx
Environment=AVP_IMAGE_PROVIDER=wanx
Environment=WANX_VIDEO_MODEL=wan2.6-t2v
Environment=ALLOW_ORIGIN=*
Environment=DEMO_QUOTA=20
ExecStart=$(command -v node) $APP_DIR/cloud/server.mjs
Restart=always
RestartSec=3
StandardOutput=append:/var/log/avp-cloud.log
StandardError=append:/var/log/avp-cloud.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable avp-cloud >/dev/null 2>&1
systemctl restart avp-cloud

# ── 4. 防火墙 ──────────────────────────────────
echo "[4/6] 开防火墙 $PORT ..."
(command -v firewall-cmd >/dev/null && firewall-cmd --permanent --add-port=$PORT/tcp && firewall-cmd --reload) 2>/dev/null || \
(ufw allow $PORT/tcp 2>/dev/null) || echo "  跳过（用云控制台安全组）"

# ── 5. 自检 ────────────────────────────────────
echo "[5/6] 等待服务就绪 ..."
for i in $(seq 1 20); do
  sleep 1
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
done
HEALTH=$(curl -s "http://127.0.0.1:$PORT/api/health" || echo '{}')
echo "  $HEALTH"

# ── 6. 输出 ────────────────────────────────────
PUBIP=$(curl -s --max-time 5 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || \
        curl -s --max-time 5 http://ifconfig.me 2>/dev/null || echo "<你的公网IP>")
echo
echo "=============================================="
echo " 部署完成"
echo " 后端地址: http://$PUBIP:$PORT"
echo " ADMIN_TOKEN: $ADMIN_TOKEN"
echo " 日志: tail -f /var/log/avp-cloud.log"
echo " 重启: systemctl restart avp-cloud"
echo "=============================================="
echo
echo "下一步（在你自己电脑上跑）："
echo "  node cloud/smoke.mjs http://$PUBIP:$PORT --admin $ADMIN_TOKEN"
echo "  node tools/publish_site.mjs http://$PUBIP:$PORT"
echo
echo "⚠ 记得在阿里云控制台【安全组】放行 $PORT/tcp"
