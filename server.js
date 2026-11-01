const Fs = require('node:fs');
const Http = require('node:http');
const Path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readConfig, isAsleep } = require('./lib/config');

const PUBLIC_DIR = Path.join(__dirname, 'public');
const RAIL_WINDOW_MS = 4 * 60 * 1000;
const BUS_POLL_MS = 30 * 1000;
const MAX_BUS_ARRIVALS = 4;
const FT_PER_MI = 5280;

const boot = readConfig();
const INSIGHTS = Path.resolve(__dirname, boot.insightsDir);
const GTFS_DIR = Path.join(INSIGHTS, 'data', 'marta', 'gtfs');
const { loadGtfs } = require(Path.join(INSIGHTS, 'src/marta/gtfs'));
const { loadShapes } = require(Path.join(INSIGHTS, 'src/marta/bus/shapes'));
const { buildLineGeometry, projectTrain } = require(Path.join(INSIGHTS, 'src/marta/rail/lines'));
const { getTripUpdates } = require(Path.join(INSIGHTS, 'src/marta/bus/api'));
const railStations = require(Path.join(INSIGHTS, 'src/marta/rail-stations.json'));

const db = new DatabaseSync(Path.join(INSIGHTS, 'state', 'marta.sqlite'), { readOnly: true });

const gtfs = loadGtfs(GTFS_DIR);
const lineGeom = buildLineGeometry(gtfs, loadShapes(GTFS_DIR));
const busRoute = gtfs.routesByShortName.get(boot.bus.route);

function buildRailMeta(lines) {
  return lines.map((line) => {
    const geom = lineGeom.get(line);
    const stations = railStations
      .filter((s) => s.lines.includes(line.toLowerCase()))
      .map((s) => {
        const p = projectTrain(lineGeom, { line, lat: s.lat, lon: s.lon });
        return p && { name: s.name, lon: s.lon, distFt: Math.round(p.distFt) };
      })
      .filter(Boolean)
      .sort((a, b) => a.distFt - b.distFt);
    const points = geom.points.map((p) => [round5(p.lat), round5(p.lon), Math.round(p.distFt)]);
    return { line, lengthFt: Math.round(geom.lengthFt), stations, points };
  });
}

const round5 = (v) => Math.round(v * 1e5) / 1e5;
const railMeta = buildRailMeta(boot.rail.lines);

function railTrains(cfg, sinceMs) {
  const placeholders = cfg.rail.lines.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ts, train_id, line, direction, destination, lat, lon, delay_sec
         FROM rail_observations WHERE ts > ? AND line IN (${placeholders}) ORDER BY ts`,
    )
    .all(sinceMs, ...cfg.rail.lines);
  const trains = [];
  for (const r of rows) {
    const p = projectTrain(lineGeom, r);
    if (!p) continue;
    trains.push({
      ts: r.ts,
      id: r.train_id,
      line: r.line,
      dir: r.direction,
      dest: r.destination,
      d: Math.round(p.distFt),
      delay: r.delay_sec,
    });
  }
  return trains;
}

function railSnapshot(cfg) {
  const now = Date.now();
  return { now, trains: railTrains(cfg, now - RAIL_WINDOW_MS), home: homeArrivals(cfg, now) };
}

function homeArrivals(cfg, now) {
  const { ts } = db.prepare('SELECT MAX(ts) AS ts FROM rail_arrivals WHERE ts > ?').get(now - 5 * 60 * 1000);
  if (!ts) return [];
  const placeholders = cfg.rail.lines.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT is_realtime, train_id, line, direction, destination, waiting_seconds
         FROM rail_arrivals WHERE ts = ? AND station = ? AND line IN (${placeholders})`,
    )
    .all(ts, cfg.rail.home.feedName, ...cfg.rail.lines);
  return rows
    .map((r) => ({
      line: r.line,
      dir: r.direction,
      dest: r.destination,
      train: r.train_id || null,
      live: r.is_realtime === 1,
      at: ts + r.waiting_seconds * 1000,
    }))
    .filter((a) => a.at > now - 30 * 1000)
    .sort((a, b) => a.at - b.at);
}

let busState = { fetchedAt: null, error: null, stops: [] };

async function pollBuses() {
  const cfg = readConfig();
  try {
    const { tripUpdates } = await getTripUpdates({ record: false });
    const now = Date.now() / 1000;
    const stops = cfg.bus.stops.map((stop) => {
      const arrivals = [];
      for (const tu of tripUpdates) {
        if (tu.scheduleRelationship === 'CANCELED') continue;
        const trip = gtfs.tripsById.get(tu.tripId);
        if (!trip || trip.route_id !== busRoute?.route_id) continue;
        const i = tu.stopUpdates.findIndex((s) => s.stopId === stop.stopId);
        if (i < 0) continue;
        const s = tu.stopUpdates[i];
        const at = s.arrivalTime ?? s.departureTime;
        if (at == null || at < now - 30) continue;
        const bus = currentBus(tu.vehicleId);
        // A vehicle's next trip is listed too; only its current trip has a meaningful position.
        const onTrip = bus?.trip_id === tu.tripId;
        arrivals.push({
          vehicle: tu.vehicleId,
          at: at * 1000,
          onTrip,
          stopsAway: onTrip ? i : null,
          lateSec: s.scheduleDeviationSec,
          miAway: onTrip ? milesAway(bus, stop.stopId) : null,
        });
      }
      arrivals.sort((a, b) => a.at - b.at);
      return { ...stop, arrivals: arrivals.slice(0, MAX_BUS_ARRIVALS) };
    });
    busState = { fetchedAt: Date.now(), error: null, stops };
  } catch (err) {
    busState = { ...busState, error: err.message };
    console.error('bus poll failed:', err.message);
  }
}

const stopsById = gtfs.stopsById;

function currentBus(vehicleId) {
  if (!vehicleId) return null;
  return db
    .prepare(
      'SELECT trip_id, lat, lon FROM bus_observations WHERE vehicle_id = ? AND ts > ? ORDER BY ts DESC LIMIT 1',
    )
    .get(vehicleId, Date.now() - 3 * 60 * 1000);
}

// Straight-line, so it reads short on a winding route; good enough for a glance.
function milesAway(bus, stopId) {
  const stop = stopsById.get(stopId);
  if (!stop) return null;
  const ft = haversineFt(bus.lat, bus.lon, Number(stop.stop_lat), Number(stop.stop_lon));
  return Math.round((ft / FT_PER_MI) * 10) / 10;
}

function haversineFt(lat1, lon1, lat2, lon2) {
  const R = 20902231;
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.json': 'application/json',
};

function sendJson(res, body) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  const urlPath = new URL(req.url, 'http://x').pathname;
  const file = Path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  Fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[Path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = Http.createServer((req, res) => {
  try {
    const cfg = readConfig();
    if (req.url === '/api/meta') {
      return sendJson(res, { timezone: cfg.timezone, rail: railMeta, home: cfg.rail.home, bus: { route: cfg.bus.route, title: cfg.bus.title, color: busRoute?.route_color } });
    }
    if (req.url === '/api/state') {
      return sendJson(res, {
        asleep: isAsleep(cfg),
        rail: railSnapshot(cfg),
        bus: busState,
      });
    }
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    res.writeHead(500).end(err.message);
  }
});

pollBuses();
setInterval(pollBuses, BUS_POLL_MS);
server.listen(boot.port, '127.0.0.1', () => console.log(`edge-display on http://127.0.0.1:${boot.port}`));
