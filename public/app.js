const MAP_W = 1840;
const H = 720;
const COLORS = { BLUE: '#2b9bff', GREEN: '#1fd17a' };

// Trains are drawn this far in the past so there is always a sample on both sides to interpolate between.
const LAG_MS = 40 * 1000;
const KEEP_MS = 5 * 60 * 1000;
const FADE_AFTER_MS = 60 * 1000;
const FADE_MS = 60 * 1000;
const MAX_STEP_FT = 5000;
const HEADING_SPAN_FT = 150;
const STALE_MS = 3 * 60 * 1000;

// Green shares Blue's track downtown; draw it just north so both stay visible.
const LINE_SHIFT = { BLUE: 0, GREEN: -13 };
const LABEL_FONT = '600 24px Inter';
const LABEL_PRIORITY = [
  'HAMILTON E HOLMES',
  'INDIAN CREEK',
  'BANKHEAD',
  'FIVE POINTS',
  'EDGEWOOD-CANDLER PARK',
  'DECATUR',
  'ASHBY',
  'WEST LAKE',
  'EAST LAKE',
  'KENSINGTON',
  'AVONDALE',
  'KING MEMORIAL',
];
const HEADER_BOX = { x: 0, y: 0, w: 760, h: 100 };
// Keep labels clear of the fade on the map's right edge (style.css #map::after).
const EDGE_FADE_PX = 44;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const staticLayer = document.createElement('canvas');

let meta = null;
let proj = null;
let lines = {};
let homeArrivals = [];
let busState = null;
let railUpdatedAt = 0;
const trains = new Map();

function fitStage() {
  const scale = Math.min(innerWidth / 2560, innerHeight / H);
  document.getElementById('stage').style.transform = `scale(${scale})`;
}

const baseName = (name) => name.replace(/ Station$/i, '');

function prettyStation(name) {
  const short = baseName(name)
    .replace('HAMILTON E HOLMES', 'H.E. HOLMES')
    .replace('INMAN PARK-REYNOLDSTOWN', 'INMAN PARK')
    .replace('EDGEWOOD-CANDLER PARK', 'EDGEWOOD');
  return short.toLowerCase().replace(/(^|[\s.-])\w/g, (m) => m.toUpperCase());
}

function prettyDest(dest) {
  return dest.replace('Hamilton E. Holmes', 'H.E. Holmes');
}

function project(lat, lon) {
  return [(lon - proj.lon0) * proj.pxPerDegLon, (proj.lat0 - lat) * proj.pxPerDegLat];
}

function buildLines() {
  const out = {};
  for (const l of meta.rail) {
    const shift = LINE_SHIFT[l.line] || 0;
    const pts = l.points.map(([lat, lon, d]) => {
      const [x, y] = project(lat, lon);
      return { x, y: y + shift, d };
    });
    out[l.line] = {
      pts,
      stations: l.stations,
      eastIsIncreasing: pts[pts.length - 1].x > pts[0].x,
    };
  }
  return out;
}

function posFor(line, d) {
  const { pts } = lines[line];
  if (d <= pts[0].d) return { x: pts[0].x, y: pts[0].y };
  const last = pts[pts.length - 1];
  if (d >= last.d) return { x: last.x, y: last.y };
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].d <= d) lo = mid;
    else hi = mid;
  }
  const span = pts[hi].d - pts[lo].d;
  const t = span ? (d - pts[lo].d) / span : 0;
  return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * t, y: pts[lo].y + (pts[hi].y - pts[lo].y) * t };
}

// The GTFS shape has many repeated and near-duplicate points, so take the heading
// across a stretch of track rather than from the segment under the train.
function headingFor(line, d) {
  const a = posFor(line, d - HEADING_SPAN_FT);
  const b = posFor(line, d + HEADING_SPAN_FT);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function ingest(rows) {
  for (const r of rows) {
    if (!lines[r.line]) continue;
    const key = `${r.line}:${r.id}`;
    let t = trains.get(key);
    if (!t) {
      t = { line: r.line, id: r.id, pts: [] };
      trains.set(key, t);
    }
    if (t.pts.some((p) => p.ts === r.ts)) continue;
    t.pts.push({ ts: r.ts, d: r.d, dir: r.dir });
    t.pts.sort((a, b) => a.ts - b.ts);
  }
  const cutoff = Date.now() - KEEP_MS;
  for (const [key, t] of trains) {
    t.pts = t.pts.filter((p) => p.ts > cutoff);
    if (!t.pts.length) trains.delete(key);
  }
}

function continuous(a, b) {
  return a.dir === b.dir && Math.abs(a.d - b.d) < MAX_STEP_FT;
}

// Cubic Hermite through the samples, clamped so a train never overshoots a stop.
function sampleAt(pts, T) {
  if (!pts.length || T < pts[0].ts) return null;
  const last = pts[pts.length - 1];
  if (T >= last.ts) return { d: last.d, dir: last.dir, held: T - last.ts };
  let i = 0;
  while (pts[i + 1].ts <= T) i++;
  const p1 = pts[i];
  const p2 = pts[i + 1];
  if (!continuous(p1, p2)) return T - p1.ts < (p2.ts - p1.ts) / 2 ? { d: p1.d, dir: p1.dir, held: 0 } : { d: p2.d, dir: p2.dir, held: 0 };
  const p0 = pts[i - 1] && continuous(pts[i - 1], p1) ? pts[i - 1] : p1;
  const p3 = pts[i + 2] && continuous(p2, pts[i + 2]) ? pts[i + 2] : p2;
  const h = p2.ts - p1.ts;
  const slope = (a, b) => (b.ts === a.ts ? 0 : (b.d - a.d) / (b.ts - a.ts));
  const m1 = slope(p0, p2) * h;
  const m2 = slope(p1, p3) * h;
  const s = (T - p1.ts) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  let d = (2 * s3 - 3 * s2 + 1) * p1.d + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * p2.d + (s3 - s2) * m2;
  d = Math.min(Math.max(d, Math.min(p1.d, p2.d)), Math.max(p1.d, p2.d));
  return { d, dir: p1.dir, held: 0 };
}

function hexA(hex, a) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function stroke(c, pts, width, color, blur) {
  c.save();
  c.lineWidth = width;
  c.strokeStyle = color;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.shadowColor = color;
  c.shadowBlur = blur;
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.stroke();
  c.restore();
}

// One marker per station; where Blue and Green both stop, a pill spans the two tracks.
function stationMarkers() {
  const byName = new Map();
  for (const [line, l] of Object.entries(lines)) {
    for (const s of l.stations) {
      const p = posFor(line, s.distFt);
      if (!byName.has(s.name)) byName.set(s.name, { name: s.name, pts: [] });
      byName.get(s.name).pts.push({ line, x: p.x, y: p.y });
    }
  }
  return [...byName.values()].map((m) => {
    const xs = m.pts.map((p) => p.x);
    const ys = m.pts.map((p) => p.y);
    return {
      name: m.name,
      x: xs.reduce((a, b) => a + b) / xs.length,
      top: Math.min(...ys),
      bottom: Math.max(...ys),
      line: m.pts.length === 1 ? m.pts[0].line : null,
    };
  });
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Greedy: most important stations first, each tries below / above / beside its marker and is skipped if nothing fits.
function placeLabels(c, markers) {
  const home = baseName(meta.home.mapName);
  const rank = (m) => {
    const n = baseName(m.name);
    if (n === home) return -1;
    return LABEL_PRIORITY.indexOf(n);
  };
  const track = Object.values(lines).flatMap((l) =>
    l.pts.filter((_, i) => i % 3 === 0).map((p) => ({ x: p.x - 5, y: p.y - 5, w: 10, h: 10 })),
  );
  const placed = [HEADER_BOX, ...track, ...markers.map((m) => ({ x: m.x - 12, y: m.top - 12, w: 24, h: m.bottom - m.top + 24 }))];
  const out = [];
  c.font = LABEL_FONT;
  const labelled = markers.filter((m) => baseName(m.name) === home || rank(m) >= 0);
  for (const m of labelled.sort((a, b) => rank(a) - rank(b))) {
    const text = prettyStation(m.name);
    const w = c.measureText(text).width;
    const h = 26;
    const options = [
      { x: m.x - w / 2, y: m.bottom + 20 },
      { x: m.x - w / 2, y: m.top - 20 - h },
      { x: m.x + 20, y: (m.top + m.bottom) / 2 - h / 2 },
      { x: m.x - 20 - w, y: (m.top + m.bottom) / 2 - h / 2 },
      { x: m.x - w / 2, y: m.bottom + 52 },
      { x: m.x - w / 2, y: m.top - 52 - h },
    ];
    for (const o of options) {
      o.x = Math.min(Math.max(o.x, 14), MAP_W - EDGE_FADE_PX - w);
      const box = { x: o.x - 4, y: o.y - 2, w: w + 8, h: h + 4 };
      if (box.y < 10 || box.y + box.h > H - 10) continue;
      if (placed.some((p) => overlaps(box, p))) continue;
      placed.push(box);
      out.push({ text, x: o.x, y: o.y, isHome: baseName(m.name) === home, anchor: m, w, h });
      break;
    }
  }
  return out;
}

function drawStatic() {
  staticLayer.width = MAP_W;
  staticLayer.height = H;
  const c = staticLayer.getContext('2d');

  for (const [line, l] of Object.entries(lines)) {
    stroke(c, l.pts, 16, hexA(COLORS[line], 0.12), 30);
    stroke(c, l.pts, 9, 'rgba(4,7,11,0.85)', 0);
    stroke(c, l.pts, 5, hexA(COLORS[line], 0.95), 14);
  }

  const markers = stationMarkers();
  const homeName = meta.home.mapName;
  for (const m of markers) {
    const isHome = m.name === homeName;
    c.save();
    c.beginPath();
    c.roundRect(m.x - 9, m.top - 9, 18, m.bottom - m.top + 18, 9);
    c.fillStyle = isHome ? '#ffffff' : '#04070b';
    c.shadowColor = isHome ? 'rgba(255,255,255,0.9)' : 'transparent';
    c.shadowBlur = isHome ? 22 : 0;
    c.fill();
    c.shadowBlur = 0;
    c.lineWidth = 3;
    c.strokeStyle = isHome ? '#ffffff' : m.line ? COLORS[m.line] : '#dfe7ef';
    c.stroke();
    c.restore();
  }

  for (const l of placeLabels(c, markers)) {
    c.save();
    c.font = l.isHome ? '750 26px Inter' : LABEL_FONT;
    c.textBaseline = 'top';
    c.lineJoin = 'round';
    c.lineWidth = 7;
    c.strokeStyle = 'rgba(4,7,11,0.92)';
    c.strokeText(l.text, l.x, l.y);
    c.fillStyle = l.isHome ? '#ffffff' : '#c3cfdb';
    c.fillText(l.text, l.x, l.y);
    c.restore();
  }
}

function drawTrains(T, wall) {
  const counts = { BLUE: 0, GREEN: 0 };
  for (const t of trains.values()) {
    const s = sampleAt(t.pts, T);
    if (!s) continue;
    const alpha = s.held > FADE_AFTER_MS ? Math.max(0, 1 - (s.held - FADE_AFTER_MS) / FADE_MS) : 1;
    if (alpha <= 0) continue;
    if (alpha === 1) counts[t.line]++;
    const color = COLORS[t.line];
    const p = posFor(t.line, s.d);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    let prev = p;
    for (let k = 1; k <= 10; k++) {
      const back = sampleAt(t.pts, T - k * 3000);
      if (!back || back.dir !== s.dir) break;
      const q = posFor(t.line, back.d);
      ctx.strokeStyle = hexA(color, 0.6 * (1 - k / 11));
      ctx.lineWidth = 8 - k * 0.6;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      prev = q;
    }

    const towardIncreasing = (s.dir === 'E') === lines[t.line].eastIsIncreasing;
    ctx.translate(p.x, p.y);
    ctx.rotate(headingFor(t.line, s.d) + (towardIncreasing ? 0 : Math.PI));
    ctx.shadowColor = color;
    ctx.shadowBlur = 26;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-17, -6, 34, 12, 6);
    ctx.fill();
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#fff';
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(7, -3.5, 8, 7, 3.5);
    ctx.fill();
    ctx.restore();
  }

  const home = stationMarkers().find((m) => m.name === meta.home.mapName);
  if (home) {
    const phase = (wall % 3200) / 3200;
    const grow = phase * 22;
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - phase)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(home.x - 9 - grow, home.top - 9 - grow, 18 + grow * 2, home.bottom - home.top + 18 + grow * 2, 9 + grow);
    ctx.stroke();
    ctx.restore();
  }
  return counts;
}

let lastCountsAt = -Infinity;

function frame(wall) {
  if (!document.body.classList.contains('asleep')) {
    const T = Date.now() - LAG_MS;
    ctx.clearRect(0, 0, MAP_W, H);
    ctx.drawImage(staticLayer, 0, 0);
    const counts = drawTrains(T, wall);
    if (wall - lastCountsAt > 1000) {
      lastCountsAt = wall;
      for (const line of Object.keys(COLORS)) {
        const el = document.getElementById(`count${line}`);
        if (el) el.textContent = counts[line] ?? 0;
      }
    }
  }
  requestAnimationFrame(frame);
}

function minutesUntil(at) {
  return Math.round((at - Date.now()) / 60000);
}

function bigHtml(at, extraClass = '') {
  const m = minutesUntil(at);
  if (m <= 0) return `<div class="big due ${extraClass}"><span class="n">Due</span></div>`;
  return `<div class="big ${extraClass}"><span class="n">${m}</span><span class="u">min</span></div>`;
}

function laterHtml(list) {
  const later = list
    .slice(0, 3)
    .map((a) => `<span class="${a.live === false ? 'sched' : ''}">${Math.max(0, minutesUntil(a.at))}</span>`)
    .join(', ');
  return later ? `then ${later}` : '&nbsp;';
}

function renderHome() {
  const rows = document.getElementById('homeRows');
  const groups = new Map();
  for (const a of homeArrivals) {
    if (a.at < Date.now() - 30 * 1000) continue;
    if (!groups.has(a.dir)) groups.set(a.dir, []);
    groups.get(a.dir).push(a);
  }
  if (!groups.size) {
    rows.innerHTML = '<div class="empty">No trains reported</div>';
    return;
  }
  const order = ['E', 'W', 'N', 'S'];
  rows.innerHTML = [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([dir, list]) => {
      const [next, ...rest] = list;
      return `<div class="row" style="--c:${COLORS[next.line]}">
        <div class="dest">
          <div class="dir"><i></i>${dir === 'E' ? 'Eastbound' : dir === 'W' ? 'Westbound' : dir}</div>
          <div class="dest-name">${prettyDest(next.dest)}</div>
          <div class="later">${laterHtml(rest)}</div>
        </div>
        ${bigHtml(next.at, next.live ? '' : 'sched')}
      </div>`;
    })
    .join('');
}

const APPROACH_STOPS = 12;

function renderBus() {
  const cols = document.getElementById('busCols');
  if (!busState?.stops?.length) {
    cols.innerHTML = '<div class="empty">Waiting for bus data</div>';
    return;
  }
  cols.innerHTML = busState.stops
    .map((stop) => {
      const list = stop.arrivals.filter((a) => a.at > Date.now() - 30 * 1000);
      if (!list.length) return `<div class="col"><div class="dir">${stop.label}</div><div class="empty">No buses</div></div>`;
      const [next, ...rest] = list;
      const bits = [];
      if (next.miAway != null) bits.push(`${next.miAway.toFixed(1)} mi`);
      if (next.lateSec != null && Math.abs(next.lateSec) >= 120) {
        const m = Math.round(Math.abs(next.lateSec) / 60);
        bits.push(`<span class="late">${m} min ${next.lateSec > 0 ? 'late' : 'early'}</span>`);
      }
      if (!next.onTrip) bits.push('not started');
      const ticks = Array.from({ length: APPROACH_STOPS }, (_, i) => `<span class="tick" style="left:${(i / APPROACH_STOPS) * 100}%"></span>`).join('');
      const busDots = list
        .filter((a) => a.stopsAway != null && a.stopsAway <= APPROACH_STOPS)
        .map((a) => `<span class="bus" style="left:calc(${((APPROACH_STOPS - a.stopsAway) / APPROACH_STOPS) * 100}% - 15px)"></span>`)
        .join('');
      return `<div class="col">
        <div class="dir">${stop.label}</div>
        ${bigHtml(next.at)}
        <div class="meta">${bits.join(' · ') || '&nbsp;'}</div>
        <div class="approach">${ticks}${busDots}<span class="stop"></span></div>
        <div class="later">${laterHtml(rest)}</div>
      </div>`;
    })
    .join('');
}

function renderStatus() {
  const now = Date.now();
  const railStale = now - railUpdatedAt > STALE_MS;
  const busStale = !busState?.fetchedAt || now - busState.fetchedAt > STALE_MS;
  document.getElementById('railLive').classList.toggle('stale', railStale);
  const status = document.getElementById('status');
  status.classList.toggle('stale', railStale || busStale);
  status.textContent = railStale ? 'Rail stale' : busStale ? 'Bus stale' : '';
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function pollState() {
  try {
    const s = await getJson('/api/state');
    document.body.classList.toggle('asleep', s.asleep);
    ingest(s.rail.trains);
    homeArrivals = s.rail.home;
    busState = s.bus;
    const latest = s.rail.trains.reduce((m, t) => Math.max(m, t.ts), 0);
    if (latest) railUpdatedAt = latest;
  } catch (err) {
    console.error(err);
  }
  renderHome();
  renderBus();
  renderStatus();
}

function brighten(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const lift = (v) => Math.min(255, Math.round(v * 1.15 + 20));
  return `rgb(${lift(n >> 16)},${lift((n >> 8) & 255)},${lift(n & 255)})`;
}

async function init() {
  fitStage();
  addEventListener('resize', fitStage);
  await document.fonts.load(LABEL_FONT);
  await document.fonts.load('750 26px Inter');
  [meta, proj] = await Promise.all([getJson('/api/meta'), getJson('/basemap.json')]);
  document.getElementById('homeTitle').textContent = meta.home.label;
  document.getElementById('busTitle').textContent = meta.bus.title;
  document.getElementById('busBadge').textContent = meta.bus.route;
  if (meta.bus.color) document.documentElement.style.setProperty('--bus', brighten(`#${meta.bus.color}`));
  canvas.width = MAP_W;
  canvas.height = H;
  lines = buildLines();
  drawStatic();
  await pollState();
  setInterval(pollState, 5000);
  setInterval(renderStatus, 1000);
  requestAnimationFrame(frame);
}

init();
