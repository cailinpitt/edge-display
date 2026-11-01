#!/usr/bin/env bash
# Launched by cage (edge-kiosk.service): power scheduler + fullscreen Chromium.
cd "$(dirname "$0")/.." || exit 1
PORT=$(node -p 'require("./config.json").port')

until node -e "fetch('http://127.0.0.1:$PORT/').then(()=>process.exit(0),()=>process.exit(1))"; do
  sleep 2
done

node bin/power.js &

exec /snap/bin/chromium \
  --kiosk --incognito \
  --ozone-platform=wayland \
  --noerrdialogs --disable-infobars --no-first-run \
  --disable-features=Translate,TranslateUI \
  --overscroll-history-navigation=0 --disable-pinch \
  --password-store=basic --hide-scrollbars \
  --check-for-update-interval=31536000 \
  "http://127.0.0.1:$PORT/"
