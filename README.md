# edge-display

A glanceable MARTA dashboard for a Corsair Xeneon Edge (2560×720) plugged into `cailin-server`.

- **Left:** live Blue/Green trains gliding over a 2.5D map of Atlanta.
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
npm run deploy   # push, git pull on the server, restart the services
```

## Basemap

`public/basemap.png` (OSM buildings + roads, © OpenStreetMap contributors) and its projection `public/basemap.json` are committed. To rebuild, download two Overpass JSON files into a folder and run `node scripts/build-basemap.js <folder>` (needs Brave or `BROWSER=<chromium>`):

- `buildings.json`: `way["building"](33.733,-84.482,33.823,-84.214); out tags geom qt;`
- `roads.json`: `way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"](same bbox); out geom qt;`

## Install (once, on the server)

```
sudo bash deploy/setup.sh
```

This installs `cage`, `wlopm` and Chromium, and adds two services: `edge-display` (the data server on `127.0.0.1:8787`) and `edge-kiosk` (fullscreen Chromium on tty1). Logs: `journalctl -u edge-kiosk -u edge-display -f`. `/hello.html` is a plain test page.
