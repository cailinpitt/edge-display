# edge-display

A glanceable MARTA dashboard for a Corsair Xeneon Edge (2560×720) plugged into `cailin-server`.

- **Left:** live trains gliding over a 2.5D map of Atlanta. It rotates between an east–west view (Blue/Green) and a north–south view (Red/Gold, map turned so the lines run across the strip). Tap to switch early.
- **Right:** next trains at the current view's home station, plus route 2 bus arrivals.

Rail data comes from the [atlanta-transit-insights](https://github.com/cailinpitt/atlanta-transit-insights) SQLite DB (read-only). Bus predictions come from MARTA's GTFS-rt TripUpdates feed through that repo's adapter, polled every 30s.

## Config

Edit `config.json` on the server. It's re-read on change, so no restart is needed.

- `sleep`: overnight hours. `mode` is `dim` (dashboard keeps running) or `black`. The monitor's backlight is set over DDC/CI (`ddcutil`, I2C bus `ddcBus`) to `monitorBrightness.night` (0 for `black`) and back to `.day` at wake; it's only touched at those switches, so manual daytime changes stick. If DDC fails, the page dims itself to `dimBrightness` (0–1) instead.
- `views`: each has `lines`, how many `seconds` it stays up, and a `home` station (`mapName` matches `rail-stations.json`, `feedName` matches the arrivals feed). Changing a view's lines needs a restart.
- `bus.stops`: GTFS stop IDs to show arrivals for.

## Develop

```
npm run dev      # http://localhost:8788, live data tunneled from the server
npm run deploy   # push, git pull on the server, restart the services
```

## Basemap

Each view has a committed `public/basemap-<view>.png` (OSM buildings + roads, © OpenStreetMap contributors) and `basemap-<view>.json` (its projection). Framing lives in `scripts/views.js`. To rebuild one (needs the insights repo checked out next to `atlanta/`, or `INSIGHTS_DIR`, and Brave or `BROWSER=<chromium>`):

```
node scripts/fetch-osm.js northsouth /tmp/osm-ns        # Overpass, tiled, resumable
node scripts/build-basemap.js northsouth /tmp/osm-ns
```

When Overpass is overloaded, cut the same files out of a [Geofabrik](https://download.geofabrik.de/north-america/us/georgia.html) extract instead (needs `brew install osmium-tool`):

```
node scripts/osm-from-pbf.js northsouth georgia-latest.osm.pbf /tmp/osm-ns
```

## Install (once, on the server)

```
sudo bash deploy/setup.sh
```

This installs `cage` and Chromium, and adds two services: `edge-display` (the data server on `127.0.0.1:8787`) and `edge-kiosk` (fullscreen Chromium on tty1). Logs: `journalctl -u edge-kiosk -u edge-display -f`. `/hello.html` is a plain test page.
