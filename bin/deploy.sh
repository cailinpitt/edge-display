#!/usr/bin/env bash
# Push main, pull it on the server, and restart the services.
set -euo pipefail
HOST=${EDGE_HOST:-cailin-server}
DEST=${EDGE_DEST:-Development/edge-display}

cd "$(dirname "$0")/.."
git push -q origin main
ssh "$HOST" "cd $DEST && git pull -q --ff-only"

if ssh "$HOST" systemctl is-enabled --quiet edge-display.service 2>/dev/null; then
  ssh "$HOST" "sudo -n systemctl restart edge-display.service && sudo -n systemctl restart edge-kiosk.service"
  echo "Deployed and restarted."
else
  echo "Pulled. Services not installed yet: ssh -t $HOST sudo bash $DEST/deploy/setup.sh"
fi
