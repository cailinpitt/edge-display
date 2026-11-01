# edge-display

A glanceable MARTA dashboard for a Corsair Xeneon Edge (2560×720) plugged into `cailin-server`.

- **Left:** live Blue/Green train positions on a schematic, with a 40-minute train-path chart above it.
- **Right:** next trains at the home station and route 2 bus arrivals.

Rail data comes from the [atlanta-transit-insights](https://github.com/cailinpitt/atlanta-transit-insights) SQLite DB (read-only). Bus predictions come from MARTA's GTFS-rt TripUpdates feed through that repo's adapter, polled every 30s.

## Config

Edit `config.json` on the server. It's re-read on change, so no restart is needed.

- `sleep`: hours the monitor is off (`wlopm`). The page also goes black as a fallback.
- `rail.home`: station to highlight. `mapName` matches `rail-stations.json`; `feedName` matches the arrivals feed.
- `bus.stops`: GTFS stop IDs to show arrivals for.

## Develop

```
npm run dev      # http://localhost:8788, live data tunneled from the server
npm run deploy   # rsync to the server and restart the services
```

## Install (once, on the server)

```
sudo bash deploy/setup.sh
```

This installs `cage`, `wlopm` and Chromium, and adds two services: `edge-display` (the data server on `127.0.0.1:8787`) and `edge-kiosk` (fullscreen Chromium on tty1). Logs: `journalctl -u edge-kiosk -u edge-display -f`. `/hello.html` is a plain test page.
