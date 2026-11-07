#!/usr/bin/env bash
# One-time install: sudo bash deploy/setup.sh
set -euo pipefail

USER_NAME=${SUDO_USER:?run with sudo}
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN=$(sudo -u "$USER_NAME" bash -lc 'command -v node')

apt-get update
apt-get install -y cage wlr-randr ddcutil
snap list chromium >/dev/null 2>&1 || snap install chromium
usermod -aG video,render,input,i2c "$USER_NAME"

for unit in edge-display edge-kiosk; do
  sed -e "s|__USER__|$USER_NAME|g" \
      -e "s|__APP__|$APP_DIR|g" \
      -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__NODE_DIR__|$(dirname "$NODE_BIN")|g" \
      "$APP_DIR/deploy/$unit.service" > "/etc/systemd/system/$unit.service"
done

# Let the app restart its own units without a password.
cat > /etc/sudoers.d/edge-display <<EOF
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl restart edge-display.service, /usr/bin/systemctl restart edge-kiosk.service
EOF
chmod 440 /etc/sudoers.d/edge-display

systemctl daemon-reload
systemctl enable --now edge-display.service
systemctl enable --now edge-kiosk.service
echo "Done. Logs: journalctl -u edge-kiosk -u edge-display -f"
