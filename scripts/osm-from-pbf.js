// Dev-time alternative to fetch-osm.js when Overpass is overloaded: cut a view's
// buildings + roads out of a Geofabrik extract with osmium-tool, written in the
// same shape fetch-osm.js produces.
//
//   node scripts/osm-from-pbf.js <view> <extract.osm.pbf> <out-dir>
//
// Needs `osmium` (brew install osmium-tool). Extracts: https://download.geofabrik.de
const { execFileSync } = require('node:child_process');
const Fs = require('node:fs');
const Path = require('node:path');
const { fitView, bbox } = require('./views');

const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];

const [viewId, pbf, outDir] = process.argv.slice(2);
if (!viewId || !pbf || !outDir) {
  console.error('usage: node scripts/osm-from-pbf.js <view> <extract.osm.pbf> <out-dir>');
  process.exit(1);
}

const b = bbox(fitView(viewId));
Fs.mkdirSync(outDir, { recursive: true });
const tmp = (name) => Path.join(outDir, name);
const osmium = (...args) => execFileSync('osmium', [...args, '--overwrite'], { stdio: 'inherit' });

osmium('extract', '-b', `${b.west},${b.south},${b.east},${b.north}`, pbf, '-o', tmp('view.osm.pbf'));
osmium('tags-filter', tmp('view.osm.pbf'), 'wr/building', `w/highway=${ROAD_CLASSES.join(',')}`, '-o', tmp('filtered.osm.pbf'));
osmium('export', tmp('filtered.osm.pbf'), '-f', 'geojsonseq', '--geometry-types=polygon,linestring', '-o', tmp('features.geojsonseq'));

const ring = (coords) => coords.map(([lon, lat]) => ({ lat, lon }));
const buildings = [];
const roads = [];
let id = 0;
for (const line of Fs.readFileSync(tmp('features.geojsonseq'), 'utf8').split('\n')) {
  const json = line.replace(/^\x1e/, '').trim();
  if (!json) continue;
  const { geometry, properties: tags } = JSON.parse(json);
  if (tags.building && geometry.type === 'Polygon') {
    buildings.push({ type: 'way', id: id++, tags, geometry: ring(geometry.coordinates[0]) });
  } else if (tags.building && geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) buildings.push({ type: 'way', id: id++, tags, geometry: ring(poly[0]) });
  } else if (ROAD_CLASSES.includes(tags.highway) && geometry.type === 'LineString') {
    roads.push({ type: 'way', id: id++, tags, geometry: ring(geometry.coordinates) });
  }
}

Fs.writeFileSync(tmp('buildings.json'), JSON.stringify({ elements: buildings }));
Fs.writeFileSync(tmp('roads.json'), JSON.stringify({ elements: roads }));
for (const f of ['view.osm.pbf', 'filtered.osm.pbf', 'features.geojsonseq']) Fs.rmSync(tmp(f));
console.log(`${buildings.length} buildings, ${roads.length} roads → ${outDir}`);
