const MAP_W = 1840;
const H = 720;
const COLORS = { BLUE: '#2b9bff', GREEN: '#1fd17a', RED: '#ff4d6a', GOLD: '#ffc23d' };

// Trains are drawn this far in the past so there is always a sample on both sides to interpolate between.
const LAG_MS = 40 * 1000;
const KEEP_MS = 5 * 60 * 1000;
const FADE_AFTER_MS = 60 * 1000;
const FADE_MS = 60 * 1000;
const MAX_STEP_FT = 5000;
const HEADING_SPAN_FT = 150;
const TRAIL_STEPS = 20;
const STALE_MS = 3 * 60 * 1000;
const FADE_VIEW_MS = 1500;
// Swipe: past this fraction of the map (or a quick flick) switches view; otherwise it springs back.
const SWIPE_COMMIT = 0.15;
const FLICK_PX_PER_MS = 0.6;
const TAP_SLOP_PX = 12;
const SETTLE_MS = 320;
const MANUAL_HOLD_MS = 2 * 60 * 1000;

// Lines that share track are nudged apart (in screen px) so both stay visible.
const LINE_SHIFT = { GREEN: { x: 0, y: -13 }, GOLD: { x: 0, y: 13 } };
const LABEL_FONT = '600 24px Inter';
// Stations to label per view, most important first; the rest get only a dot.
const LABEL_PRIORITY = {
  eastwest: [
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
  ],
  northsouth: [
    'AIRPORT',
    'NORTH SPRINGS',
    'DORAVILLE',
    'LINDBERGH CENTER',
    'MIDTOWN',
    'BUCKHEAD',
    'EAST POINT',
    'WEST END',
    'DUNWOODY',
    'CHAMBLEE',
    'COLLEGE PARK',
    'LENOX',
    'MEDICAL CENTER',
    'OAKLAND CITY',
    'ARTS CENTER',
    'BROOKHAVEN-OGLETHORPE',
    'SANDY SPRINGS',
    'LAKEWOOD-FT MCPHERSON',
    'NORTH AVE',
    'PEACHTREE CENTER',
  ],
};
const DIR_NAMES = { E: 'Eastbound', W: 'Westbound', N: 'Northbound', S: 'Southbound' };
const HEADER_BOX = { x: 0, y: 0, w: 760, h: 100 };
// Keep labels clear of the fade on the map's right edge (style.css #map::after).
const EDGE_FADE_PX = 44;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let meta = null;
let views = [];
let viewIdx = 0;
let viewSince = 0;
let fadeFrom = null;
let stageScale = 1;
let drag = null;
let settle = null;
let holdUntil = 0;
// Which way along each line's distance axis is north / east, from its geography.
const lineAxis = {};
let homeArrivals = {};
let busState = null;
let railUpdatedAt = 0;
const trains = new Map();

function fitStage() {
  stageScale = Math.min(innerWidth / 2560, innerHeight / H);
  document.getElementById('stage').style.transform = `scale(${stageScale})`;
}

const baseName = (name) => name.replace(/ Station$/i, '');

function prettyStation(name) {
  const short = baseName(name)
    .replace('HAMILTON E HOLMES', 'H.E. HOLMES')
    .replace('INMAN PARK-REYNOLDSTOWN', 'INMAN PARK')
    .replace('EDGEWOOD-CANDLER PARK', 'EDGEWOOD')
    .replace('LINDBERGH CENTER', 'LINDBERGH')
    .replace('LAKEWOOD-FT MCPHERSON', 'LAKEWOOD')
    .replace('BROOKHAVEN-OGLETHORPE', 'BROOKHAVEN');
  return short.toLowerCase().replace(/(^|[\s.-])\w/g, (m) => m.toUpperCase());
}

function prettyDest(dest) {
  return dest.replace('Hamilton E. Holmes', 'H.E. Holmes');
}

// Same projection as scripts/views.js: rotate east/north offsets by the view's angle.
function projector(p) {
  const a = (p.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return (lat, lon) => {
    const u = (lon - p.lonRef) * p.cosLat;
    const v = lat - p.latRef;
    return [p.x0 + p.scale * (u * cos + v * sin), p.y0 + p.scale * (u * sin - v * cos)];
  };
}

function buildView(cfg, proj) {
  const project = projector(proj);
  const view = { ...cfg, lines: {} };
  for (const l of meta.rail.filter((r) => cfg.lines.includes(r.line))) {
    const shift = LINE_SHIFT[l.line] || { x: 0, y: 0 };
    const pts = l.points.map(([lat, lon, d]) => {
      const [x, y] = project(lat, lon);
      return { x: x + shift.x, y: y + shift.y, d };
    });
    view.lines[l.line] = { pts, stations: l.stations };
  }
  view.markers = stationMarkers(view);
  view.homeMarker = view.markers.find((m) => m.name === cfg.home.mapName);
  view.staticLayer = drawStatic(view);
  view.img = document.createElement('img');
  view.img.className = 'basemap';
  view.img.src = `basemap-${cfg.id}.png`;
  document.getElementById('map').prepend(view.img);
  return view;
}

function towardIncreasing(line, dir) {
  const { dLat, dLon } = lineAxis[line];
  if (dir === 'N' || dir === 'S') return (dir === 'N') === dLat > 0;
  return (dir === 'E') === dLon > 0;
}

function posFor(view, line, d) {
  const { pts } = view.lines[line];
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
function headingFor(view, line, d) {
  const a = posFor(view, line, d - HEADING_SPAN_FT);
  const b = posFor(view, line, d + HEADING_SPAN_FT);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function ingest(rows) {
  for (const r of rows) {
    if (!lineAxis[r.line]) continue;
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

// One marker per station; where two lines both stop, a pill spans the two tracks.
function stationMarkers(view) {
  const byName = new Map();
  for (const [line, l] of Object.entries(view.lines)) {
    for (const s of l.stations) {
      const p = posFor(view, line, s.distFt);
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
function placeLabels(view, c) {
  const { markers } = view;
  const home = baseName(view.home.mapName);
  const priority = LABEL_PRIORITY[view.id];
  const rank = (m) => {
    const n = baseName(m.name);
    if (n === home) return -1;
    return priority ? priority.indexOf(n) : 0;
  };
  const track = Object.values(view.lines).flatMap((l) =>
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

function drawStatic(view) {
  const layer = document.createElement('canvas');
  layer.width = MAP_W;
  layer.height = H;
  const c = layer.getContext('2d');

  for (const [line, l] of Object.entries(view.lines)) {
    stroke(c, l.pts, 16, hexA(COLORS[line], 0.12), 30);
    stroke(c, l.pts, 9, 'rgba(4,7,11,0.85)', 0);
    stroke(c, l.pts, 5, hexA(COLORS[line], 0.95), 14);
  }

  const homeName = view.home.mapName;
  for (const m of view.markers) {
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

  for (const l of placeLabels(view, c)) {
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
  return layer;
}

// Pointing along +x: rounded tail, arrow nose.
function trainPath() {
  ctx.beginPath();
  ctx.moveTo(-17, -11);
  ctx.lineTo(13, -11);
  ctx.lineTo(27, 0);
  ctx.lineTo(13, 11);
  ctx.lineTo(-17, 11);
  ctx.arc(-17, 0, 11, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
}

function drawTrains(view, T, wall) {
  const counts = Object.fromEntries(Object.keys(view.lines).map((l) => [l, 0]));
  for (const t of trains.values()) {
    if (!view.lines[t.line]) continue;
    const s = sampleAt(t.pts, T);
    if (!s) continue;
    const alpha = s.held > FADE_AFTER_MS ? Math.max(0, 1 - (s.held - FADE_AFTER_MS) / FADE_MS) : 1;
    if (alpha <= 0) continue;
    if (alpha === 1) counts[t.line]++;
    const color = COLORS[t.line];
    const p = posFor(view, t.line, s.d);

    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.lineCap = 'round';
    let prev = p;
    for (let k = 1; k <= TRAIL_STEPS; k++) {
      const back = sampleAt(t.pts, T - k * 3000);
      if (!back || back.dir !== s.dir) break;
      const q = posFor(view, t.line, back.d);
      const fade = 1 - k / (TRAIL_STEPS + 1);
      ctx.strokeStyle = hexA(color, 0.75 * fade);
      ctx.lineWidth = 3 + 9 * fade;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      prev = q;
    }

    ctx.translate(p.x, p.y);
    ctx.rotate(headingFor(view, t.line, s.d) + (towardIncreasing(t.line, s.dir) ? 0 : Math.PI));
    trainPath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(4,7,11,0.95)';
    ctx.stroke();
    ctx.shadowColor = color;
    ctx.shadowBlur = 30;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();

    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    for (const cx of [-9, 3]) {
      ctx.beginPath();
      ctx.moveTo(cx - 4, -6);
      ctx.lineTo(cx + 3, 0);
      ctx.lineTo(cx - 4, 6);
      ctx.stroke();
    }
    ctx.restore();
  }

  const home = view.homeMarker;
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
// Reported to the server, which restarts the kiosk if this stops climbing.
let framesDrawn = 0;

function drawView(view, T, wall, alpha, offsetX = 0) {
  view.img.style.opacity = alpha;
  view.img.style.transform = offsetX ? `translateX(${offsetX}px)` : '';
  if (alpha <= 0) return null;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(offsetX, 0);
  ctx.drawImage(view.staticLayer, 0, 0);
  const counts = drawTrains(view, T, wall);
  ctx.restore();
  return counts;
}

function frame(wall) {
  // Scheduled first so a throw in one frame can't stop the loop for good.
  requestAnimationFrame(frame);
  if (!document.body.classList.contains('blackout')) {
    framesDrawn++;
    const now = Date.now();
    const view = views[viewIdx];
    const idle = !drag && !settle;
    if (idle && views.length > 1 && now > holdUntil && now - viewSince > view.seconds * 1000) {
      showView((viewIdx + 1) % views.length);
    }
    const T = now - LAG_MS;
    ctx.clearRect(0, 0, MAP_W, H);
    const offset = slideOffset(now);
    const neighbor = offset ? views[(viewIdx + (offset < 0 ? 1 : -1) + views.length) % views.length] : null;
    const f = fadeFrom ? Math.min(1, (now - viewSince) / FADE_VIEW_MS) : 1;
    if (f >= 1) fadeFrom = null;
    for (const v of views) {
      if (v !== views[viewIdx] && v !== fadeFrom && v !== neighbor) drawView(v, T, wall, 0);
    }
    if (fadeFrom) drawView(fadeFrom, T, wall, 1 - f);
    if (neighbor) drawView(neighbor, T, wall, 1, offset + (offset < 0 ? MAP_W : -MAP_W));
    // null on the frame a rotation starts, when the incoming view's fade is 0.
    const counts = drawView(views[viewIdx], T, wall, f, offset);
    if (counts && wall - lastCountsAt > 1000) {
      lastCountsAt = wall;
      for (const line of Object.keys(views[viewIdx].lines)) {
        const el = document.getElementById(`count${line}`);
        if (el) el.textContent = counts[line] ?? 0;
      }
    }
  }
}

// Current horizontal offset of the map while dragging or springing to rest.
function slideOffset(now) {
  if (drag) return drag.dx;
  if (!settle) return 0;
  const t = Math.min(1, (now - settle.start) / SETTLE_MS);
  const eased = 1 - (1 - t) ** 3;
  const x = settle.from + (settle.to - settle.from) * eased;
  if (t >= 1) {
    const done = settle;
    settle = null;
    if (done.to !== 0) showView(done.targetIdx, { fade: false, manual: true });
    return 0;
  }
  return x;
}

function onPointerDown(e) {
  if (views.length < 2 || settle) return;
  e.currentTarget.setPointerCapture(e.pointerId);
  drag = { startX: e.clientX, dx: 0, lastX: e.clientX, lastT: e.timeStamp, vx: 0 };
}

function onPointerMove(e) {
  if (!drag) return;
  drag.dx = Math.max(-MAP_W, Math.min(MAP_W, (e.clientX - drag.startX) / stageScale));
  const dt = e.timeStamp - drag.lastT;
  if (dt > 0) drag.vx = (e.clientX - drag.lastX) / stageScale / dt;
  drag.lastX = e.clientX;
  drag.lastT = e.timeStamp;
}

function onPointerUp() {
  if (!drag) return;
  const { dx, vx } = drag;
  drag = null;
  if (Math.abs(dx) < TAP_SLOP_PX) {
    showView((viewIdx + 1) % views.length, { manual: true });
    return;
  }
  const commit = Math.abs(dx) > MAP_W * SWIPE_COMMIT || (Math.abs(vx) > FLICK_PX_PER_MS && Math.sign(vx) === Math.sign(dx));
  const targetIdx = (viewIdx + (dx < 0 ? 1 : -1) + views.length) % views.length;
  settle = { from: dx, to: commit ? Math.sign(dx) * MAP_W : 0, start: Date.now(), targetIdx };
}

function showView(i, { fade = true, manual = false } = {}) {
  if (manual) holdUntil = Date.now() + MANUAL_HOLD_MS;
  if (i === viewIdx) return;
  fadeFrom = fade ? views[viewIdx] : null;
  viewIdx = i;
  viewSince = Date.now();
  const head = document.querySelector('.map-head');
  const home = document.getElementById('homeBlock');
  head.classList.add('swapping');
  home.classList.add('swapping');
  setTimeout(() => {
    renderPills();
    renderHome();
    lastCountsAt = -Infinity;
    head.classList.remove('swapping');
    home.classList.remove('swapping');
  }, 400);
}

function minutesUntil(at) {
  return Math.round((at - Date.now()) / 60000);
}

function bigHtml(at, extraClass = '') {
  const m = minutesUntil(at);
  if (m <= 0) return `<div class="big due ${extraClass}"><span class="n">Due</span></div>`;
  return `<div class="big ${extraClass}"><span class="n">${m}</span><span class="u">min</span></div>`;
}

// When a direction mixes lines (e.g. Red and Gold northbound), color each time by its line.
function laterHtml(list, mixed = false) {
  const later = list
    .slice(0, 3)
    .map((a) => {
      const style = mixed && a.live !== false ? ` style="color:${COLORS[a.line]}"` : '';
      return `<span class="${a.live === false ? 'sched' : ''}"${style}>${Math.max(0, minutesUntil(a.at))}</span>`;
    })
    .join(', ');
  return later ? `then ${later}` : '&nbsp;';
}

function renderHome() {
  const view = views[viewIdx];
  document.getElementById('homeTitle').textContent = view.home.label;
  const rows = document.getElementById('homeRows');
  const groups = new Map();
  for (const a of homeArrivals[view.id] || []) {
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
      const mixed = new Set(list.map((a) => a.line)).size > 1;
      return `<div class="row" style="--c:${COLORS[next.line]}">
        <div class="dest">
          <div class="dir"><i></i>${DIR_NAMES[dir] || dir}</div>
          <div class="dest-name">${prettyDest(next.dest)}</div>
          <div class="later">${laterHtml(rest, mixed)}</div>
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
    timeZone: meta?.timezone,
  });
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function pollState() {
  try {
    const drawing = document.body.classList.contains('blackout') ? 0 : 1;
    const s = await getJson(`/api/state?frames=${framesDrawn}&drawing=${drawing}`);
    const dim = s.asleep && s.sleep.mode === 'dim';
    document.body.classList.toggle('blackout', s.asleep && !dim);
    // The monitor's own backlight is lowered over DDC when that works; otherwise dim the page.
    document.body.classList.toggle('dimmed', dim && !s.sleep.hardware);
    document.documentElement.style.setProperty('--dim-brightness', s.sleep.dimBrightness);
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

function renderPills() {
  const view = views[viewIdx];
  const pills = Object.keys(view.lines)
    .map((line) => `<span class="pill" style="--c:${COLORS[line]}"><i></i>${line[0]}${line.slice(1).toLowerCase()} <b id="count${line}">–</b></span>`)
    .join('');
  const dots = views.length > 1 ? `<span class="dots">${views.map((v) => `<i class="${v === view ? 'on' : ''}"></i>`).join('')}</span>` : '';
  document.getElementById('pills').innerHTML = pills + dots;
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
  meta = await getJson('/api/meta');
  for (const l of meta.rail) {
    const [first, last] = [l.points[0], l.points[l.points.length - 1]];
    lineAxis[l.line] = { dLat: last[0] - first[0], dLon: last[1] - first[1] };
  }
  // A view whose basemap hasn't been built is skipped rather than breaking the page.
  const projections = await Promise.all(
    meta.views.map((v) => getJson(`/basemap-${v.id}.json`).catch((err) => console.error(err))),
  );
  views = meta.views.filter((_, i) => projections[i]).map((v) => buildView(v, projections[meta.views.indexOf(v)]));
  viewSince = Date.now();
  document.getElementById('busTitle').textContent = meta.bus.title;
  document.getElementById('busBadge').textContent = meta.bus.route;
  if (meta.bus.color) document.documentElement.style.setProperty('--bus', brighten(`#${meta.bus.color}`));
  canvas.width = MAP_W;
  canvas.height = H;
  renderPills();
  const map = document.getElementById('map');
  map.addEventListener('pointerdown', onPointerDown);
  map.addEventListener('pointermove', onPointerMove);
  map.addEventListener('pointerup', onPointerUp);
  map.addEventListener('pointercancel', onPointerUp);
  await pollState();
  setInterval(pollState, 5000);
  setInterval(renderStatus, 1000);
  requestAnimationFrame(frame);
}

init();
