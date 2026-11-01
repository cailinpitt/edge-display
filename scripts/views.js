// Map framing for each view: which lines it fits, at what rotation, into which
// part of the 1840×720 map. Shared by fetch-osm.js and build-basemap.js.
const Path = require('node:path');

const WIDTH = 1840;
const HEIGHT = 720;
const FT_PER_DEG_LAT = 364000;
const INSIGHTS_DIR = process.env.INSIGHTS_DIR || Path.join(__dirname, '..', '..', 'atlanta', 'atlanta-transit-insights');

// angle 0 = north up; 90 = north to the right. `angles` searches for the best fit.
const VIEWS = {
  eastwest: { lines: ['blue', 'green'], angles: [0, 0], box: { x0: 70, x1: 1750, y0: 300, y1: 650 } },
  northsouth: { lines: ['red', 'gold'], angles: [45, 135], box: { x0: 80, x1: 1760, y0: 150, y1: 630 } },
};

function rotate(u, v, angle) {
  const a = (angle * Math.PI) / 180;
  return [u * Math.cos(a) + v * Math.sin(a), u * Math.sin(a) - v * Math.cos(a)];
}

function fitView(id) {
  const view = VIEWS[id];
  if (!view) throw new Error(`unknown view ${id}; one of ${Object.keys(VIEWS).join(', ')}`);
  const stations = require(Path.join(INSIGHTS_DIR, 'src/marta/rail-stations.json')).filter((s) =>
    s.lines.some((l) => view.lines.includes(l)),
  );
  const latRef = stations.reduce((a, s) => a + s.lat, 0) / stations.length;
  const lonRef = stations.reduce((a, s) => a + s.lon, 0) / stations.length;
  const cosLat = Math.cos((latRef * Math.PI) / 180);
  const { box } = view;

  let best = null;
  for (let angle = view.angles[0]; angle <= view.angles[1]; angle++) {
    const pts = stations.map((s) => rotate((s.lon - lonRef) * cosLat, s.lat - latRef, angle));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [xMin, xMax, yMin, yMax] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = Math.min((box.x1 - box.x0) / (xMax - xMin), (box.y1 - box.y0) / (yMax - yMin));
    if (!best || scale > best.scale) {
      best = {
        angle,
        scale,
        x0: (box.x0 + box.x1) / 2 - (scale * (xMin + xMax)) / 2,
        y0: (box.y0 + box.y1) / 2 - (scale * (yMin + yMax)) / 2,
      };
    }
  }
  return { id, width: WIDTH, height: HEIGHT, latRef, lonRef, cosLat, ...best, pxPerFt: best.scale / FT_PER_DEG_LAT };
}

function projector(p) {
  return (lat, lon) => {
    const [x, y] = rotate((lon - p.lonRef) * p.cosLat, lat - p.latRef, p.angle);
    return [p.x0 + p.scale * x, p.y0 + p.scale * y];
  };
}

// The rotation is its own inverse, so un-projecting reuses it.
function unproject(p, x, y) {
  const [u, v] = rotate((x - p.x0) / p.scale, (y - p.y0) / p.scale, p.angle);
  return { lat: p.latRef + v, lon: p.lonRef + u / p.cosLat };
}

function bbox(p, padDeg = 0.003) {
  const corners = [
    [0, 0],
    [p.width, 0],
    [0, p.height],
    [p.width, p.height],
  ].map(([x, y]) => unproject(p, x, y));
  const lats = corners.map((c) => c.lat);
  const lons = corners.map((c) => c.lon);
  return {
    south: Math.min(...lats) - padDeg,
    west: Math.min(...lons) - padDeg,
    north: Math.max(...lats) + padDeg,
    east: Math.max(...lons) + padDeg,
  };
}

module.exports = { VIEWS, fitView, projector, bbox };
