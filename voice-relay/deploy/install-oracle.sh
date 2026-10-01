#!/usr/bin/env bash
# One-shot installer for the StackChan voice relay on a fresh Oracle Cloud
# "Always Free" Ubuntu VM (Ampere ARM or AMD micro both work).
#
# Run as root:  sudo bash install-oracle.sh
#
# It installs Python, ffmpeg and the relay's dependencies, creates a dedicated
# system user, writes /etc/stackchan-relay.env for the settings, and enables a
# systemd service that survives reboots.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="stackchan"
ENV_FILE="/etc/stackchan-relay.env"
UNIT_FILE="/etc/systemd/system/stackchan-relay.service"
PORT="${RELAY_PORT:-8080}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Please run with sudo: sudo bash $0" >&2
  exit 1
fi

echo "==> installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip ffmpeg ca-certificates curl rsync

echo "==> creating service user and directories"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" /opt/stackchan-relay
rsync -a --delete \
  --exclude '.venv' --exclude '__pycache__' --exclude 'tools' --exclude '*.log' --exclude '.env' --exclude 'config.json' \
  "$REPO_DIR"/ /opt/stackchan-relay/
chown -R "$SERVICE_USER:$SERVICE_USER" /opt/stackchan-relay

echo "==> creating the Python environment"
sudo -u "$SERVICE_USER" python3 -m venv /opt/stackchan-relay/.venv
sudo -u "$SERVICE_USER" /opt/stackchan-relay/.venv/bin/pip install --quiet --upgrade pip
sudo -u "$SERVICE_USER" /opt/stackchan-relay/.venv/bin/pip install --quiet -r /opt/stackchan-relay/requirements.txt

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> writing $ENV_FILE (fill in the three secrets)"
  cat >"$ENV_FILE" <<ENV
# Cloudflare Worker 调用的登录密钥。用下面命令生成:
#   openssl rand -hex 32
RELAY_TOKEN=
# 机器人的控制密钥(64 位小写 hex), 与固件 device_control_secret.h 一致。
DEVICE_CONTROL_SECRET=
# 自己的机器人 MAC, 与 Worker ROBOT_MAC 一致。
ROBOT_MAC=
# 默认公共 broker; 更换时须同步固件和 Worker 并重新验证。
MQTT_HOST=broker-cn.emqx.io
MQTT_PORT=1883
TOPIC_PREFIX=stackchan
PORT=$PORT
BIND_HOST=127.0.0.1
CHAT_TIMEOUT_S=120
ENV
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
fi

echo "==> writing $UNIT_FILE"
cat >"$UNIT_FILE" <<UNIT
[Unit]
Description=StackChan voice relay (typed chat to the robot's own xiaozhi session)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=/opt/stackchan-relay
EnvironmentFile=$ENV_FILE
ExecStart=/opt/stackchan-relay/.venv/bin/python /opt/stackchan-relay/server.py
Restart=always
RestartSec=5
# 只需要写自己的临时目录; 语音合成的中间文件放在 /tmp
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now stackchan-relay.service

echo
echo "==> done"
systemctl --no-pager --lines=0 status stackchan-relay.service || true
echo
echo "Check it locally:   curl -s localhost:$PORT/healthz"
echo "Keep port $PORT bound to localhost; publish a valid HTTPS entry with"
echo "Tailscale Funnel or a TLS reverse proxy, then set the Cloudflare secrets:"
echo "wrangler secret put RELAY_URL / RELAY_TOKEN"
