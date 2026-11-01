#!/usr/bin/env bash
# Sync this repo to the server and restart the services.
set -euo pipefail
HOST=${EDGE_HOST:-cailin-server}
DEST=${EDGE_DEST:-Development/edge-display}

cd "$(dirname "$0")/.."
rsync -az --delete --exclude .git --exclude node_modules ./ "$HOST:$DEST/"

if ssh "$HOST" systemctl is-enabled --quiet edge-display.service 2>/dev/null; then
  ssh "$HOST" "sudo -n systemctl restart edge-display.service && sudo -n systemctl restart edge-kiosk.service"
  echo "Deployed and restarted."
else
  echo "Synced. Services not installed yet: ssh -t $HOST sudo bash $DEST/deploy/setup.sh"
fi
