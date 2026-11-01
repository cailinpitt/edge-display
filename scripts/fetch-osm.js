// Dev-time: download OSM buildings + major roads for a view from Overpass.
//
//   node scripts/fetch-osm.js <view> <out-dir>
//
// Buildings come down in tiles (skipping tiles outside the rotated frame) so no
// single query is large enough to time out.
const Fs = require('node:fs');
const Path = require('node:path');
const { fitView, bbox, projector } = require('./views');

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'edge-display-basemap/1.0 (personal dashboard)';
const TILES = 5;
const MARGIN_PX = 120;
const RETRIES = 5;

const [viewId, outDir] = process.argv.slice(2);
if (!viewId || !outDir) {
  console.error('usage: node scripts/fetch-osm.js <view> <out-dir>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, file) {
  if (Fs.existsSync(file)) return console.log(`have ${Path.basename(file)}`);
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }),
    });
    const text = await res.text();
    if (res.ok && text.startsWith('{')) {
      Fs.writeFileSync(file, text);
      console.log(`got ${Path.basename(file)} (${(text.length / 1e6).toFixed(1)} MB)`);
      return;
    }
    const wait = 15000 * 2 ** (attempt - 1);
    console.log(`${Path.basename(file)}: ${res.status}, retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
  throw new Error(`gave up on ${file}`);
}

async function main() {
  const p = fitView(viewId);
  const b = bbox(p);
  const project = projector(p);
  Fs.mkdirSync(outDir, { recursive: true });

  const inFrame = (lat, lon) => {
    const [x, y] = project(lat, lon);
    return x > -MARGIN_PX && x < p.width + MARGIN_PX && y > -MARGIN_PX && y < p.height + MARGIN_PX;
  };

  const dLat = (b.north - b.south) / TILES;
  const dLon = (b.east - b.west) / TILES;
  for (let i = 0; i < TILES; i++) {
    for (let j = 0; j < TILES; j++) {
      const s = b.south + i * dLat;
      const w = b.west + j * dLon;
      const probes = [0, 0.5, 1].flatMap((fy) => [0, 0.5, 1].map((fx) => [s + fy * dLat, w + fx * dLon]));
      if (!probes.some(([lat, lon]) => inFrame(lat, lon))) continue;
      const box = `${s},${w},${s + dLat},${w + dLon}`;
      await overpass(
        `[out:json][timeout:600][maxsize:1073741824];way["building"](${box});out tags geom qt;`,
        Path.join(outDir, `buildings-${i}-${j}.json`),
      );
    }
  }
  await overpass(
    `[out:json][timeout:300];way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"](${b.south},${b.west},${b.north},${b.east});out geom qt;`,
    Path.join(outDir, 'roads.json'),
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
