const MAP_W = 1840;
const H = 720;
const COLORS = { BLUE: '#2b9bff', GREEN: '#1fd17a' };

// Trains are drawn this far in the past so there is always a sample on both sides to interpolate between.
const LAG_MS = 40 * 1000;
const HISTORY_MS = 40 * 60 * 1000;
const FADE_AFTER_MS = 60 * 1000;
const FADE_MS = 60 * 1000;
const MAX_STEP_FT = 5000;
const STALE_MS = 3 * 60 * 1000;

const X0 = 120;
const X1 = 1650;
const MAREY_TOP = 112;
const MAREY_BOTTOM = 424;
const GREEN_Y = 474;
const BLUE_Y = 506;
const JOG_Y = 446;
const TRAIN_OFFSET = 7;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const staticLayer = document.createElement('canvas');

let meta = null;
let layout = null;
let homeArrivals = [];
let busState = null;
let railUpdatedAt = 0;
const trains = new Map();

function fitStage() {
  const scale = Math.min(innerWidth / 2560, innerHeight / H);
  document.getElementById('stage').style.transform = `scale(${scale})`;
}

function prettyStation(name) {
  return name
    .replace(/ Station$/i, '')
    .replace('HAMILTON E HOLMES', 'H.E. HOLMES')
    .replace('INMAN PARK-REYNOLDSTOWN', 'INMAN PARK');
}

function prettyDest(dest) {
  return dest.replace('Hamilton E. Holmes', 'H.E. Holmes');
}

// Schematic: Blue runs straight across; Green rides alongside it and jogs up to Bankhead.
function buildLayout() {
  const blue = meta.rail.find((l) => l.line === 'BLUE');
  const green = meta.rail.find((l) => l.line === 'GREEN');
  const xByName = new Map();
  const lines = {};

  if (blue) {
    const st = [...blue.stations].sort((a, b) => a.lon - b.lon);
    const lonMin = st[0].lon;
    const lonMax = st[st.length - 1].lon;
    st.forEach((s, i) => {
      const even = i / (st.length - 1);
      const geo = (s.lon - lonMin) / (lonMax - lonMin);
      xByName.set(s.name, X0 + (X1 - X0) * (0.6 * even + 0.4 * geo));
    });
    lines.BLUE = { nodes: st.map((s) => ({ x: xByName.get(s.name), y: BLUE_Y, station: s })) };
  }

  if (green) {
    const st = [...green.stations].sort((a, b) => a.lon - b.lon);
    const nodes = [];
    for (const s of st) {
      if (xByName.has(s.name)) {
        nodes.push({ x: xByName.get(s.name), y: GREEN_Y, station: s });
      } else {
        nodes.push({ x: null, y: JOG_Y, station: s, branch: true });
      }
    }
    const firstShared = nodes.findIndex((n) => !n.branch);
    const ashby = nodes[firstShared];
    const westLake = [...xByName.entries()].find(([n]) => n.startsWith('WEST LAKE'));
    const branchX = westLake ? ashby.x - 0.5 * (ashby.x - westLake[1]) : ashby.x - 70;
    for (let i = 0; i < firstShared; i++) nodes[i].x = branchX - (firstShared - 1 - i) * 60;
    nodes.splice(firstShared, 0, { x: ashby.x - (GREEN_Y - JOG_Y), y: JOG_Y });
    lines.GREEN = { nodes };
  }

  for (const l of Object.values(lines)) {
    l.anchors = l.nodes.map((n, i) => (n.station ? i : -1)).filter((i) => i >= 0);
  }
  return { lines, xByName };
}

function pointAlong(nodes, from, to, f) {
  const segs = [];
  let total = 0;
  for (let i = from; i < to; i++) {
    const len = Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].y - nodes[i].y);
    segs.push(len);
    total += len;
  }
  let target = f * total;
  for (let i = from; i < to; i++) {
    const len = segs[i - from];
    if (target <= len || i === to - 1) {
      const t = len ? Math.min(1, target / len) : 0;
      const a = nodes[i];
      const b = nodes[i + 1];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tx: (b.x - a.x) / len, ty: (b.y - a.y) / len };
    }
    target -= len;
  }
  return { x: nodes[from].x, y: nodes[from].y, tx: 1, ty: 0 };
}

// Map along-track feet onto the schematic, piecewise between station anchors.
function posFor(line, d) {
  const l = layout.lines[line];
  if (!l) return null;
  const { nodes, anchors } = l;
  for (let k = 0; k < anchors.length - 1; k++) {
    const a = nodes[anchors[k]].station.distFt;
    const b = nodes[anchors[k + 1]].station.distFt;
    if ((d - a) * (d - b) <= 0) {
      return pointAlong(nodes, anchors[k], anchors[k + 1], a === b ? 0 : (d - a) / (b - a));
    }
  }
  const first = nodes[anchors[0]].station.distFt;
  const last = nodes[anchors[anchors.length - 1]].station.distFt;
  const atStart = Math.abs(d - first) < Math.abs(d - last);
  return atStart ? pointAlong(nodes, anchors[0], anchors[1], 0) : pointAlong(nodes, anchors[anchors.length - 2], anchors[anchors.length - 1], 1);
}

function ingest(rows) {
  for (const r of rows) {
    const key = `${r.line}:${r.id}`;
    let t = trains.get(key);
    if (!t) {
      t = { line: r.line, id: r.id, pts: [] };
      trains.set(key, t);
    }
    t.dest = r.dest;
    if (t.pts.some((p) => p.ts === r.ts)) continue;
    t.pts.push({ ts: r.ts, d: r.d, dir: r.dir });
    t.pts.sort((a, b) => a.ts - b.ts);
  }
  const cutoff = Date.now() - HISTORY_MS - LAG_MS - 60 * 1000;
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

function maryY(T, ts) {
  return MAREY_BOTTOM - ((T - ts) / HISTORY_MS) * (MAREY_BOTTOM - MAREY_TOP);
}

function strokeTrack(c, nodes, width, color, blur) {
  c.save();
  c.lineWidth = width;
  c.strokeStyle = color;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.shadowColor = color;
  c.shadowBlur = blur;
  c.beginPath();
  nodes.forEach((n, i) => (i ? c.lineTo(n.x, n.y) : c.moveTo(n.x, n.y)));
  c.stroke();
  c.restore();
}

function drawStatic() {
  staticLayer.width = MAP_W;
  staticLayer.height = H;
  const c = staticLayer.getContext('2d');
  const homeName = meta.home.mapName;

  c.strokeStyle = 'rgba(255,255,255,0.035)';
  c.lineWidth = 1;
  for (const x of layout.xByName.values()) {
    c.beginPath();
    c.moveTo(Math.round(x) + 0.5, MAREY_TOP);
    c.lineTo(Math.round(x) + 0.5, MAREY_BOTTOM);
    c.stroke();
  }

  c.font = '500 12px Inter';
  c.textAlign = 'right';
  c.fillStyle = '#34404d';
  for (let m = 10; m <= 40; m += 10) {
    const y = Math.round(MAREY_BOTTOM - (m / 40) * (MAREY_BOTTOM - MAREY_TOP)) + 0.5;
    c.strokeStyle = 'rgba(255,255,255,0.04)';
    c.setLineDash([2, 6]);
    c.beginPath();
    c.moveTo(X0 - 20, y);
    c.lineTo(X1 + 20, y);
    c.stroke();
    c.setLineDash([]);
    c.fillText(`${m} MIN AGO`, MAP_W - 64, y + 4);
  }

  for (const [line, l] of Object.entries(layout.lines)) {
    strokeTrack(c, l.nodes, 12, hexA(COLORS[line], 0.1), 24);
    strokeTrack(c, l.nodes, 3, hexA(COLORS[line], 0.9), 10);
  }

  const shared = new Set();
  if (layout.lines.GREEN) for (const n of layout.lines.GREEN.nodes) if (n.station && !n.branch) shared.add(n.station.name);

  const marker = (x, y1, y2, color, isHome) => {
    c.save();
    c.beginPath();
    c.roundRect(x - 7, y1 - 7, 14, y2 - y1 + 14, 7);
    c.fillStyle = isHome ? '#e9eef4' : '#05080b';
    c.shadowColor = isHome ? 'rgba(233,238,244,0.8)' : 'transparent';
    c.shadowBlur = isHome ? 18 : 0;
    c.fill();
    c.shadowBlur = 0;
    c.lineWidth = 2;
    c.strokeStyle = color;
    c.stroke();
    c.restore();
  };

  const label = (text, x, y, isHome) => {
    c.save();
    c.translate(x, y);
    c.rotate(Math.PI / 5.6);
    c.textAlign = 'left';
    c.font = isHome ? '700 15px Inter' : '500 14px Inter';
    c.letterSpacing = '2px';
    c.fillStyle = isHome ? '#ffffff' : '#7d8b9c';
    c.fillText(text, 0, 0);
    c.restore();
  };

  if (layout.lines.BLUE) {
    for (const n of layout.lines.BLUE.nodes) {
      const isHome = n.station.name === homeName;
      const both = shared.has(n.station.name);
      marker(n.x, both ? GREEN_Y : BLUE_Y, BLUE_Y, isHome ? '#ffffff' : both ? '#cfd8e3' : COLORS.BLUE, isHome);
      label(prettyStation(n.station.name), n.x + 4, BLUE_Y + 30, isHome);
    }
  }
  if (layout.lines.GREEN) {
    for (const n of layout.lines.GREEN.nodes) {
      if (!n.branch) continue;
      marker(n.x, JOG_Y, JOG_Y, COLORS.GREEN, n.station.name === homeName);
      c.save();
      c.font = '500 14px Inter';
      c.letterSpacing = '2px';
      c.fillStyle = '#7d8b9c';
      c.textAlign = 'right';
      c.fillText(prettyStation(n.station.name), n.x - 18, JOG_Y + 5);
      c.restore();
    }
  }
}

function hexA(hex, a) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawMarey(T) {
  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  for (const t of trains.values()) {
    const color = COLORS[t.line];
    const pts = t.pts.filter((p) => p.ts <= T && p.ts >= T - HISTORY_MS);
    const now = sampleAt(t.pts, T);
    if (now && !now.held) pts.push({ ts: T, d: now.d, dir: now.dir });
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!continuous(a, b)) continue;
      const age = (T - b.ts) / HISTORY_MS;
      ctx.strokeStyle = hexA(color, 0.08 + 0.62 * (1 - age) ** 1.6);
      ctx.beginPath();
      ctx.moveTo(posFor(t.line, a.d).x, maryY(T, a.ts));
      ctx.lineTo(posFor(t.line, b.d).x, maryY(T, b.ts));
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawTrains(T, wall) {
  const counts = { BLUE: 0, GREEN: 0 };
  for (const t of trains.values()) {
    const s = sampleAt(t.pts, T);
    if (!s) continue;
    const alpha = s.held > FADE_AFTER_MS ? Math.max(0, 1 - (s.held - FADE_AFTER_MS) / FADE_MS) : 1;
    if (alpha <= 0) continue;
    if (alpha === 1) counts[t.line] = (counts[t.line] || 0) + 1;
    const color = COLORS[t.line];
    const side = s.dir === 'E' ? 1 : -1;
    const p = posFor(t.line, s.d);
    const ox = -p.ty * TRAIN_OFFSET * side;
    const oy = p.tx * TRAIN_OFFSET * side;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    let prev = { x: p.x + ox, y: p.y + oy };
    for (let k = 1; k <= 8; k++) {
      const back = sampleAt(t.pts, T - k * 3000);
      if (!back || back.dir !== s.dir) break;
      const q = posFor(t.line, back.d);
      const pt = { x: q.x - q.ty * TRAIN_OFFSET * side, y: q.y + q.tx * TRAIN_OFFSET * side };
      ctx.strokeStyle = hexA(color, 0.5 * (1 - k / 9));
      ctx.lineWidth = 5 - k * 0.45;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      prev = pt;
    }

    const facing = s.dir === 'E' ? 1 : -1;
    ctx.translate(p.x + ox, p.y + oy);
    ctx.rotate(Math.atan2(p.ty * facing, p.tx * facing));
    ctx.shadowColor = color;
    ctx.shadowBlur = 22;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-12, -4, 24, 8, 4);
    ctx.fill();
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#fff';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.roundRect(5, -2.5, 6, 5, 2.5);
    ctx.fill();
    ctx.restore();
  }

  const homeNode = layout.lines.BLUE?.nodes.find((n) => n.station.name === meta.home.mapName);
  if (homeNode) {
    const phase = (wall % 3200) / 3200;
    ctx.save();
    ctx.strokeStyle = `rgba(233,238,244,${0.45 * (1 - phase)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(homeNode.x - 7 - phase * 16, GREEN_Y - 7 - phase * 16, 14 + phase * 32, BLUE_Y - GREEN_Y + 14 + phase * 32, 7 + phase * 16);
    ctx.stroke();
    ctx.restore();
  }
  return counts;
}

let lastCountsAt = -Infinity;

function frame(wall) {
  if (document.body.classList.contains('asleep') || !layout) {
    requestAnimationFrame(frame);
    return;
  }
  const T = Date.now() - LAG_MS;
  ctx.clearRect(0, 0, MAP_W, H);
  ctx.drawImage(staticLayer, 0, 0);
  drawMarey(T);
  const counts = drawTrains(T, wall);
  if (wall - lastCountsAt > 1000) {
    lastCountsAt = wall;
    for (const line of Object.keys(COLORS)) {
      const el = document.getElementById(`count${line}`);
      if (el) el.textContent = counts[line] ?? 0;
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
  return `<div class="big ${extraClass}"><span class="n">${m}</span><span class="u">MIN</span></div>`;
}

function renderHome() {
  const rows = document.getElementById('homeRows');
  const groups = new Map();
  for (const a of homeArrivals) {
    if (a.at < Date.now() - 30 * 1000) continue;
    const key = a.dir;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
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
      const color = COLORS[next.line];
      const later = rest
        .slice(0, 3)
        .map((a) => `<span class="${a.live ? '' : 'sched'}">${Math.max(0, minutesUntil(a.at))}</span>`)
        .join(' · ');
      return `<div class="row" style="--c:${color}">
        <div class="dest">
          <div class="dir"><i></i>${dir === 'E' ? 'Eastbound' : dir === 'W' ? 'Westbound' : dir}</div>
          <div class="dest-name">${prettyDest(next.dest)}</div>
          <div class="later">${later ? `then ${later} min` : '&nbsp;'}</div>
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
      if (!list.length) return `<div class="col"><div class="dir">${stop.label}</div><div class="empty">No buses scheduled</div></div>`;
      const [next, ...rest] = list;
      const bits = [];
      if (next.miAway != null) bits.push(`${next.miAway.toFixed(1)} mi`);
      if (next.stopsAway != null) bits.push(`${next.stopsAway} ${next.stopsAway === 1 ? 'stop' : 'stops'}`);
      if (next.lateSec != null && Math.abs(next.lateSec) >= 120) {
        const m = Math.round(Math.abs(next.lateSec) / 60);
        bits.push(`<span class="late">${m} min ${next.lateSec > 0 ? 'late' : 'early'}</span>`);
      }
      if (!next.onTrip) bits.push('not yet departed');
      const ticks = Array.from({ length: APPROACH_STOPS }, (_, i) => `<span class="tick" style="left:calc(${(i / APPROACH_STOPS) * 100}% )"></span>`).join('');
      const busDots = list
        .filter((a) => a.stopsAway != null && a.stopsAway <= APPROACH_STOPS)
        .map((a) => `<span class="bus" style="left:calc(${((APPROACH_STOPS - a.stopsAway) / APPROACH_STOPS) * 100}% - 6px)"></span>`)
        .join('');
      const later = rest
        .slice(0, 3)
        .map((a) => Math.max(0, minutesUntil(a.at)))
        .join(' · ');
      return `<div class="col">
        <div class="dir">${stop.label}</div>
        ${bigHtml(next.at)}
        <div class="meta">${bits.join(' · ') || '&nbsp;'}</div>
        <div class="approach">${ticks}${busDots}<span class="stop"></span></div>
        <div class="later">${later ? `then ${later} min` : '&nbsp;'}</div>
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
  status.textContent = railStale ? 'Rail feed stale' : busStale ? 'Bus feed stale' : 'Live';
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

async function pollHistory() {
  try {
    ingest((await getJson('/api/history')).trains);
  } catch (err) {
    console.error(err);
  }
}

async function init() {
  fitStage();
  addEventListener('resize', fitStage);
  await document.fonts.load('500 14px Inter');
  await document.fonts.load('700 15px Inter');
  meta = await getJson('/api/meta');
  document.getElementById('homeTitle').textContent = meta.home.label;
  document.getElementById('busTitle').textContent = meta.bus.title;
  document.getElementById('busBadge').textContent = meta.bus.route;
  if (meta.bus.color) document.documentElement.style.setProperty('--bus', brighten(`#${meta.bus.color}`));
  canvas.width = MAP_W;
  canvas.height = H;
  layout = buildLayout();
  drawStatic();
  await pollHistory();
  await pollState();
  setInterval(pollState, 5000);
  setInterval(pollHistory, 5 * 60 * 1000);
  setInterval(renderStatus, 1000);
  requestAnimationFrame(frame);
}

function brighten(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const lift = (v) => Math.min(255, Math.round(v * 1.15 + 20));
  return `rgb(${lift(n >> 16)},${lift((n >> 8) & 255)},${lift(n & 255)})`;
}

init();
