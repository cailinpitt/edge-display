// Dev-time: render OSM buildings + roads into public/basemap.png and write the
// matching projection to public/basemap.json.
//
//   node scripts/build-basemap.js <osm-dir>
//
// <osm-dir> holds Overpass JSON: buildings.json (way["building"], out tags geom)
// and roads.json (major highways, out geom). See README for the queries.
const { execFileSync } = require('node:child_process');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

const WIDTH = 1840;
const HEIGHT = 720;
const WEST_LON = -84.47003;
const EAST_LON = -84.22953;
const MARGIN_LEFT = 70;
const MARGIN_RIGHT = 90;
const ANCHOR_LAT = 33.765;
const ANCHOR_Y = 470;
const FT_PER_DEG_LAT = 364000;
const FT_PER_M = 3.281;
const FT_PER_LEVEL = 13;
const DEFAULT_HEIGHT_FT = 22;
const BROWSER = process.env.BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

const osmDir = process.argv[2];
if (!osmDir) {
  console.error('usage: node scripts/build-basemap.js <osm-dir>');
  process.exit(1);
}

const pxPerDegLon = (WIDTH - MARGIN_LEFT - MARGIN_RIGHT) / (EAST_LON - WEST_LON);
const pxPerDegLat = pxPerDegLon / Math.cos((ANCHOR_LAT * Math.PI) / 180);
const projection = {
  width: WIDTH,
  height: HEIGHT,
  lon0: WEST_LON - MARGIN_LEFT / pxPerDegLon,
  lat0: ANCHOR_LAT + ANCHOR_Y / pxPerDegLat,
  pxPerDegLon,
  pxPerDegLat,
};

const project = ({ lat, lon }) => [
  Math.round((lon - projection.lon0) * pxPerDegLon * 10) / 10,
  Math.round((projection.lat0 - lat) * pxPerDegLat * 10) / 10,
];

function heightFt(tags = {}) {
  const h = Number.parseFloat(tags.height);
  if (Number.isFinite(h)) return h * FT_PER_M;
  const levels = Number.parseFloat(tags['building:levels']);
  if (Number.isFinite(levels)) return levels * FT_PER_LEVEL;
  return DEFAULT_HEIGHT_FT;
}

const read = (name) => JSON.parse(Fs.readFileSync(Path.join(osmDir, name), 'utf8')).elements;

const buildings = read('buildings.json')
  .filter((w) => w.type === 'way' && w.geometry?.length > 2)
  .map((w) => ({ pts: w.geometry.map(project), ft: Math.round(heightFt(w.tags)) }));
const roads = read('roads.json')
  .filter((w) => w.type === 'way' && w.geometry?.length > 1)
  .map((w) => ({ pts: w.geometry.map(project), cls: w.tags?.highway }));

console.log(`${buildings.length} buildings, ${roads.length} roads`);

const data = { pxPerFt: pxPerDegLat / FT_PER_DEG_LAT, buildings, roads };
const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'basemap-'));
const html = Path.join(tmp, 'render.html');
Fs.writeFileSync(
  html,
  Fs.readFileSync(Path.join(__dirname, 'basemap-render.html'), 'utf8').replace(
    '/*DATA*/',
    `const DATA = ${JSON.stringify(data)};`,
  ),
);

const out = Path.join(__dirname, '..', 'public', 'basemap.png');
execFileSync(BROWSER, [
  '--headless=new',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--window-size=${WIDTH},${HEIGHT}`,
  '--virtual-time-budget=20000',
  `--screenshot=${out}`,
  `file://${html}`,
], { stdio: 'ignore' });
Fs.writeFileSync(Path.join(__dirname, '..', 'public', 'basemap.json'), `${JSON.stringify(projection, null, 2)}\n`);
Fs.rmSync(tmp, { recursive: true });
console.log(`wrote ${out}`);
