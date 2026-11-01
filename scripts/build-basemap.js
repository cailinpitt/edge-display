// Dev-time: render OSM buildings + roads for a view into public/basemap-<view>.png
// and write its projection to public/basemap-<view>.json.
//
//   node scripts/build-basemap.js <view> <osm-dir>
//
// <osm-dir> is what scripts/fetch-osm.js wrote (buildings*.json + roads.json).
const { execFileSync } = require('node:child_process');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { fitView, projector } = require('./views');

const FT_PER_M = 3.281;
const FT_PER_LEVEL = 13;
const DEFAULT_HEIGHT_FT = 22;
const MARGIN_PX = 60;
const FIVE_POINTS = [33.75387, -84.39157];
const BROWSER = process.env.BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

const [viewId, osmDir] = process.argv.slice(2);
if (!viewId || !osmDir) {
  console.error('usage: node scripts/build-basemap.js <view> <osm-dir>');
  process.exit(1);
}

const projection = fitView(viewId);
const toPx = projector(projection);
const project = ({ lat, lon }) => toPx(lat, lon).map((v) => Math.round(v * 10) / 10);

function heightFt(tags = {}) {
  const h = Number.parseFloat(tags.height);
  if (Number.isFinite(h)) return h * FT_PER_M;
  const levels = Number.parseFloat(tags['building:levels']);
  if (Number.isFinite(levels)) return levels * FT_PER_LEVEL;
  return DEFAULT_HEIGHT_FT;
}

const onCanvas = (pts) =>
  pts.some(([x, y]) => x > -MARGIN_PX && x < projection.width + MARGIN_PX && y > -MARGIN_PX && y < projection.height + MARGIN_PX);

function readWays(pattern) {
  const seen = new Map();
  for (const f of Fs.readdirSync(osmDir).filter((n) => pattern.test(n))) {
    for (const el of JSON.parse(Fs.readFileSync(Path.join(osmDir, f), 'utf8')).elements) {
      if (el.type === 'way' && el.geometry?.length > 1) seen.set(el.id, el);
    }
  }
  return [...seen.values()];
}

const buildings = readWays(/^buildings.*\.json$/)
  .filter((w) => w.geometry.length > 2)
  .map((w) => ({ pts: w.geometry.map(project), ft: Math.round(heightFt(w.tags)) }))
  .filter((b) => onCanvas(b.pts));
const roads = readWays(/^roads\.json$/)
  .map((w) => ({ pts: w.geometry.map(project), cls: w.tags?.highway }))
  .filter((r) => onCanvas(r.pts));

console.log(`${viewId}: ${buildings.length} buildings, ${roads.length} roads, angle ${projection.angle}°`);

const data = { pxPerFt: projection.pxPerFt, glow: toPx(...FIVE_POINTS), buildings, roads };
const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'basemap-'));
const html = Path.join(tmp, 'render.html');
Fs.writeFileSync(
  html,
  Fs.readFileSync(Path.join(__dirname, 'basemap-render.html'), 'utf8').replace(
    '/*DATA*/',
    `const DATA = ${JSON.stringify(data)};`,
  ),
);

const publicDir = Path.join(__dirname, '..', 'public');
const out = Path.join(publicDir, `basemap-${viewId}.png`);
execFileSync(BROWSER, [
  '--headless=new',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--window-size=${projection.width},${projection.height}`,
  '--virtual-time-budget=60000',
  `--screenshot=${out}`,
  `file://${html}`,
], { stdio: 'ignore' });
Fs.writeFileSync(Path.join(publicDir, `basemap-${viewId}.json`), `${JSON.stringify(projection, null, 2)}\n`);
Fs.rmSync(tmp, { recursive: true });
console.log(`wrote ${out}`);
