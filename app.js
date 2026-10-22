/* Living London v2 — the city's pulse (TfL crowding), where London is curious (Wikipedia), and live weather.
   Everything is fetched from the browser (all sources send CORS headers). Nothing is invented: where a value is a
   typical pattern rather than a live reading, the page says so. */
(() => {
const { MapboxOverlay, ColumnLayer, PathLayer, ScatterplotLayer, TripsLayer, TextLayer, ArcLayer } = deck;
const TZ = 'Europe/London';
const HOME = { center: [-0.105, 51.508], zoom: 11.9, pitch: 58, bearing: -17 };
const REFRESH_MS = 60000;
const DAYS = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
const DAYNAME = { MON:'Monday', TUE:'Tuesday', WED:'Wednesday', THU:'Thursday', FRI:'Friday', SAT:'Saturday', SUN:'Sunday' };
const DTYPE = { MON:'mon', TUE:'midweek', WED:'midweek', THU:'midweek', FRI:'fri', SAT:'sat', SUN:'sun' };
const LINE_COLOURS = {
  bakerloo:'#B36305', central:'#E32017', circle:'#FFD300', district:'#00A03A', 'hammersmith-city':'#F3A9BB',
  jubilee:'#A0A5A9', metropolitan:'#B5006A', northern:'#EDEDED', piccadilly:'#2A62E8', victoria:'#0098D4',
  'waterloo-city':'#95CDBA', elizabeth:'#8A6CD4', dlr:'#00A4A7', liberty:'#9EA2A4', lioness:'#FAA61A',
  mildmay:'#1E90D0', suffragette:'#5BBD72', weaver:'#B8558A', windrush:'#ED1B00'
};
const hex = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const n = x => Math.round(x).toLocaleString('en-GB');
const fmtTime = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);
const fmtTimeS = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
const slotLabel = s => `${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')}`;
function londonNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const day = p.weekday.slice(0, 3).toUpperCase(); const mins = +p.hour * 60 + +p.minute;
  return { day, mins, slot: Math.floor(mins / 15) };
}
function metres(a, b) { const k = Math.PI / 180, x = (b[0]-a[0]) * Math.cos((a[1]+b[1]) / 2 * k), y = b[1]-a[1]; return Math.sqrt(x*x + y*y) * 111320; }
function classify(statuses) {
  const d = (statuses || []).map(s => s.desc);
  if (!d.length) return 'good';
  if (d.some(x => /Severe|Suspended|Closed|Closure|Not Running/i.test(x))) return 'severe';
  if (d.some(x => !/Good Service|No Issues|Information|No Step Free/i.test(x))) return 'minor';
  return 'good';
}
async function gj(u, opt) {
  const r = await fetch(u, { cache: 'no-store', ...(opt || {}) });
  if (r.status === 429) { const e = new Error('rate limited (HTTP 429)'); e.rate = true; throw e; }
  if (!r.ok) throw new Error(new URL(u).host + ' HTTP ' + r.status);
  return r.json();
}

// ---------- state ----------
const S = {
  net: null, lineIndex: {}, linePaths: [], trips: [], stations: [], stById: new Map(),
  status: null, air: null, bikes: null, weather: null, storm: null,
  crowd: new Map(), crowdChecked: 0, crowdErrors: 0, crowdBackoff: 0,
  wiki: { bursts: [], seeds: [], seen: 0, london: 0, since: Date.now(), connected: false, lookups: 0, cache: new Map(), pending: new Map() },
  errors: {}, show: { pulse: true, wiki: true, tube: true, air: true, weather: true, bikes: false },
  day: null, slot: 0, followNow: true, playing: false,
  selectedLine: null, focus: null, arc: null, orbit: false, lastUpdate: null, nextAt: 0,
};

// ---------- map ----------
const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/dark', ...HOME, maxPitch: 80, antialias: true, attributionControl: false });
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Powered by TfL Open Data · TfL Annual Station Counts 2025 · Wikipedia/Wikimedia EventStreams · Weather: Open-Meteo.com (CC BY 4.0) · Air: London Air (Imperial College ERG)' }));
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.on('styleimagemissing', e => { if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
let mapReady = false;
map.on('load', () => {
  try { map.setPaintProperty('background', 'background-color', '#05060c'); map.setPaintProperty('water', 'fill-color', '#0a1530'); } catch (e) {}
  map.addLayer({ id: '3d-buildings', source: 'openmaptiles', 'source-layer': 'building', type: 'fill-extrusion', minzoom: 12.5,
    paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#11131f', 40, '#1d2135', 120, '#2c3355', 250, '#3f3a70'],
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.5, ['coalesce', ['get', 'render_height'], 8]],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.8 } });
  mapReady = true; applyAtmosphere();
});
const overlay = new MapboxOverlay({ interleaved: false, layers: [], getCursor: ({ isHovering }) => isHovering ? 'pointer' : 'grab' });
map.addControl(overlay);

// ---------- static network + typical crowding (built once from TfL; see data/london.json "sources") ----------
let boundaryRings = [];
function inLondon(lon, lat) {
  if (!boundaryRings.length) return lon > -0.52 && lon < 0.34 && lat > 51.28 && lat < 51.7;
  let inside = false;
  for (const ring of boundaryRings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function prepareNetwork(net) {
  const b = net.boundary;
  if (b) boundaryRings = b.type === 'Polygon' ? [b.coordinates[0]] : b.coordinates.map(p => p[0]);
  S.stations = net.stations.map(s => {
    const prof = s.profile ? Object.fromEntries(Object.entries(s.profile).map(([d, str]) => [d, Array.from(str, c => (c.charCodeAt(0) - 48) / 100)])) : null;
    const sums = prof ? Object.fromEntries(Object.entries(prof).map(([d, a]) => [d, a.reduce((x, y) => x + y, 0)])) : null;
    return { ...s, pos: [s.lon, s.lat], prof, sums, phase: Math.random() * Math.PI * 2 };
  });
  S.stations.forEach(s => S.stById.set(s.id, s));
  buildLines();
}
function buildLines() {
  S.lineIndex = {}; S.linePaths = []; S.trips = [];
  const statusById = Object.fromEntries((S.status?.lines || []).map(l => [l.id, l]));
  for (const l of S.net?.lines || []) {
    const st = statusById[l.id];
    const cls = st ? classify(st.statuses) : 'unknown';
    const col = hex(LINE_COLOURS[l.id] || '#ffffff');
    let minX=180,minY=90,maxX=-180,maxY=-90;
    S.lineIndex[l.id] = { id: l.id, name: st?.name || l.name || l.id, cls, col, statuses: st?.statuses || [], bounds: null };
    for (const p of l.paths) {
      if (p.length < 2) continue;
      S.linePaths.push({ id: l.id, path: p, col, cls });
      const cum = [0];
      for (let i = 1; i < p.length; i++) cum.push(cum[i-1] + metres(p[i-1], p[i]));
      const L = cum[cum.length-1], speed = cls === 'good' ? 0.75 : cls === 'minor' ? 0.35 : 0.12, P = 6;
      const copies = Math.ceil(L / 1000 / (speed * P)) + 1;
      for (let k = 0; k < copies; k++) S.trips.push({ id: l.id, col, cls, path: p, ts: cum.map(c => c / 1000 / speed - k * P) });
      for (const [x,y] of p) { minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y); }
    }
    if (maxX > minX) S.lineIndex[l.id].bounds = [[minX,minY],[maxX,maxY]];
  }
}

// ---------- busyness model ----------
// typical: TfL crowding profile (percentage of baseline per 15 min) for that weekday.
// "≈ taps per 15 min" = TfL 2025 typical daily entries+exits × this slot's share of the day's profile (a derived estimate).
// live: TfL /crowding/{naptan}/Live percentage of baseline, compared with the typical value for the same slot.
function liveFor(s) {
  const c = s.lu && S.crowd.get(s.lu);
  if (!c || !c.dataAvailable || !c.timeLocal) return null;
  const [d, t] = c.timeLocal.split(' '); const [hh, mm] = t.split(':').map(Number);
  const ageMin = (Date.now() - Date.parse(c.timeUtc)) / 60000;
  if (ageMin > 60) return null;
  const day = DAYS[(new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7];
  const slot = Math.floor((hh * 60 + mm) / 15);
  const typ = s.prof?.[day]?.[slot];
  return { pct: c.percentageOfBaseline, typ, ratio: typ > 0.005 && c.percentageOfBaseline > 0 ? c.percentageOfBaseline / typ : null, zero: !(c.percentageOfBaseline > 0), slot, day, timeLocal: t.slice(0, 5), ageMin };
}
function busy(s, day = S.day, slot = S.slot) {
  const daily = s.daily?.[DTYPE[day]];
  if (!s.prof || !s.prof[day]) return { kind: 'daily', daily, flow: null };
  const typ = s.prof[day][slot], sum = s.sums[day] || 1;
  const typFlow = daily ? daily * typ / sum : null;
  const out = { kind: 'typical', typ, typFlow, flow: typFlow, daily };
  if (S.followNow && S.show.pulse) {
    const lv = liveFor(s);
    if (lv && lv.ratio != null) { out.kind = 'live'; out.live = lv; out.flow = typFlow != null ? typFlow * lv.ratio : null; }
    else if (lv) { out.liveRaw = lv; }
  }
  return out;
}
function busiestSlot(s, day) {
  const a = s.prof?.[day]; if (!a) return null;
  let bi = 0; a.forEach((v, i) => { if (v > a[bi]) bi = i; });
  return { slot: bi, pct: a[bi] };
}

// ---------- colours ----------
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i]-v) * Math.max(0, Math.min(1, t))));
const AMB = [255,181,71], HOT = [255,61,187], CYN = [46,242,255], WHT = [240,240,255], VIO = [178,140,255];
function pulseColour(b) {
  if (b.kind === 'live') { const r = b.live.ratio; return r < 1 ? mix(CYN, WHT, (r - 0.4) / 0.6) : mix(WHT, HOT, (r - 1) / 0.6); }
  const f = b.flow ? Math.min(1, Math.log10(1 + b.flow) / 4) : 0;
  return mix([120,70,30], AMB, f * 1.4).map((v, i) => f > .7 ? mix(AMB, [255,240,200], (f - .7) / .3)[i] : v);
}
function airColour(i) { if (i <= 3) return [61,255,162]; if (i <= 6) return [255,181,71]; if (i <= 9) return [255,75,92]; return [190,80,255]; }

// ---------- layers ----------
function layers(t) {
  const L = [], sel = S.selectedLine, dimFor = id => sel && sel !== id ? 0.12 : 1;
  const zoom = map.getZoom();
  if (S.show.air && S.air) {
    const ph = (Math.sin(t * 1.4) + 1) / 2;
    L.push(new ScatterplotLayer({ id: 'air-halo', data: S.air.sites, getPosition: d => [d.lon, d.lat], getRadius: d => 380 + d.index * 90, radiusUnits: 'meters', radiusMaxPixels: 140, getFillColor: d => [...airColour(d.index), 30] }));
    L.push(new ScatterplotLayer({ id: 'air-core', data: S.air.sites, getPosition: d => [d.lon, d.lat], getRadius: 6, radiusUnits: 'pixels', getFillColor: d => [...airColour(d.index), 200 + 55 * ph], stroked: true, getLineColor: [0,0,0,200], lineWidthMinPixels: 1, pickable: true, updateTriggers: { getFillColor: Math.round(ph * 10) } }));
  }
  if (S.show.tube && S.linePaths.length) {
    const flick = (Math.sin(t * 9) > 0.2) ? 1 : 0.35;
    L.push(new PathLayer({ id: 'line-glow', data: S.linePaths, getPath: d => d.path, widthUnits: 'pixels', getWidth: d => d.cls === 'severe' ? 12 : 8,
      getColor: d => d.cls === 'severe' ? [255,40,60, 60 * flick * dimFor(d.id)] : [...d.col, 40 * dimFor(d.id)], capRounded: true, jointRounded: true, parameters: { depthTest: false }, updateTriggers: { getColor: [flick, sel] } }));
    L.push(new PathLayer({ id: 'line-core', data: S.linePaths, getPath: d => d.path, widthUnits: 'pixels', getWidth: 2.2, pickable: true,
      getColor: d => [...d.col, (d.cls === 'severe' ? 100 + 110 * flick : d.cls === 'minor' ? 170 : 210) * dimFor(d.id)], capRounded: true, jointRounded: true, parameters: { depthTest: false }, updateTriggers: { getColor: [flick, sel] } }));
    L.push(new TripsLayer({ id: 'line-flow', data: S.trips, getPath: d => d.path, getTimestamps: d => d.ts, getColor: d => d.cls === 'severe' ? [255,90,90] : mix(d.col, [255,255,255], .5),
      opacity: sel ? 0.2 : 0.65, widthMinPixels: 2.6, trailLength: 2.2, fadeTrail: true, currentTime: (t * 1.2) % 6, capRounded: true, parameters: { depthTest: false } }));
  }
  if (S.show.pulse && S.stations.length) {
    const data = S.stations.map(s => ({ s, b: busy(s) }));
    const prof = data.filter(d => d.b.flow != null), daily = data.filter(d => d.b.flow == null);
    const es = Math.min(1.2, Math.max(0.08, Math.pow(2, (12 - zoom) * 0.8)));
    // breathing columns: height = ≈ taps per 15 min (live-adjusted where live exists)
    L.push(new ColumnLayer({ id: 'pulse-col', data: prof, getPosition: d => d.s.pos, diskResolution: 16, radius: 70, extruded: true, pickable: true, autoHighlight: true, highlightColor: [255,255,255,255],
      elevationScale: es, getElevation: d => 20 + d.b.flow * 0.32 * (1 + 0.07 * Math.sin(t * (1.2 + Math.min(4, d.b.flow / 1500)) + d.s.phase)),
      getFillColor: d => [...pulseColour(d.b), 225], material: { ambient: 0.6, diffuse: 0.6, shininess: 50, specularColor: [140,120,160] },
      updateTriggers: { getElevation: [t, S.day, S.slot, S.crowd.size], getFillColor: [S.day, S.slot, S.crowd.size, S.followNow] } }));
    // pulse rings: rhythm scales with busyness
    L.push(new ScatterplotLayer({ id: 'pulse-ring', data: prof, getPosition: d => d.s.pos, radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 1.4,
      getRadius: d => { const ph = ((t * (0.25 + Math.min(1.2, d.b.flow / 4000))) + d.s.phase / 6.283) % 1; return 80 + ph * (150 + Math.sqrt(d.b.flow) * 9); },
      getLineColor: d => { const ph = ((t * (0.25 + Math.min(1.2, d.b.flow / 4000))) + d.s.phase / 6.283) % 1; return [...pulseColour(d.b), 210 * (1 - ph)]; },
      radiusMaxPixels: 90, parameters: { depthTest: false }, updateTriggers: { getRadius: t, getLineColor: t } }));
    L.push(new ScatterplotLayer({ id: 'pulse-live-dot', data: prof.filter(d => d.b.kind === 'live'), getPosition: d => d.s.pos, getRadius: 3, radiusUnits: 'pixels', getFillColor: [255,61,187,255], stroked: true, getLineColor: [255,255,255,220], lineWidthMinPixels: 1, parameters: { depthTest: false } }));
    // stations without a 15-minute profile: steady dim ring sized by TfL's daily count
    L.push(new ScatterplotLayer({ id: 'pulse-daily', data: daily, getPosition: d => d.s.pos, radiusUnits: 'meters', radiusMinPixels: 2.5, getRadius: d => d.b.daily ? 60 + Math.sqrt(d.b.daily) * 1.2 : 60,
      stroked: true, filled: true, getFillColor: [200,205,230,40], getLineColor: [200,205,230,150], lineWidthMinPixels: 1, pickable: true, parameters: { depthTest: false }, updateTriggers: { getRadius: S.day } }));
  }
  if (S.show.bikes && S.bikes) {
    L.push(new ColumnLayer({ id: 'bikes', data: S.bikes, getPosition: d => [d.lon, d.lat], radius: 18, diskResolution: 8, extruded: true, pickable: true,
      elevationScale: Math.min(1, Math.max(0.1, Math.pow(2, (12.3 - zoom) * 0.8))), getElevation: d => 10 + d.bikes * 10, getFillColor: d => d.bikes ? [...mix(CYN, HOT, d.ebikes / Math.max(1, d.bikes)), 200] : [70,74,92,160] }));
  }
  if (S.show.wiki) {
    const now = Date.now(), W = S.wiki;
    const live = W.bursts.filter(b => now - b.t < 10 * 60e3);
    L.push(new ScatterplotLayer({ id: 'wiki-seed', data: W.seeds, getPosition: d => d.pos, getRadius: 3, radiusUnits: 'pixels', getFillColor: d => d.kind === 'recent' ? [215,195,255,235] : [178,140,255,140], stroked: true, getLineColor: d => d.kind === 'recent' ? [178,140,255,150] : [178,140,255,70], lineWidthUnits: 'pixels', getLineWidth: d => d.kind === 'recent' ? 2 : 1, pickable: true, parameters: { depthTest: false } }));
    L.push(new ScatterplotLayer({ id: 'wiki-burst', data: live, getPosition: d => d.pos, radiusUnits: 'pixels', pickable: true, parameters: { depthTest: false },
      getRadius: d => { const a = (now - d.t) / 1000; return 5 + Math.max(0, 1 - a / 300) * 6 + (a < 8 ? (1 - a / 8) * 26 : 0); },
      getFillColor: d => { const a = (now - d.t) / 1000; return [210,190,255, 255 * Math.max(0.15, 1 - a / 600)]; },
      stroked: true, getLineColor: d => { const a = (now - d.t) / 1000; return [178,140,255, 200 * Math.max(0, 1 - a / 300)]; }, lineWidthMinPixels: 6,
      updateTriggers: { getRadius: t, getFillColor: t, getLineColor: t } }));
    L.push(new ScatterplotLayer({ id: 'wiki-shock', data: live.filter(b => now - b.t < 30000), getPosition: d => d.pos, radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 2,
      getRadius: d => ((now - d.t) / 1000 % 3) / 3 * 900, getLineColor: d => [220,200,255, 255 * (1 - ((now - d.t) / 1000 % 3) / 3)], parameters: { depthTest: false }, updateTriggers: { getRadius: t, getLineColor: t } }));
    L.push(new TextLayer({ id: 'wiki-label', data: live.filter(b => now - b.t < 180e3), getPosition: d => d.pos, getText: d => d.title, getSize: 13, getPixelOffset: [0, -18],
      getColor: d => [235,225,255, 255 * Math.max(0, 1 - (now - d.t) / 180e3)], fontFamily: 'Space Grotesk, sans-serif', fontWeight: 600, outlineWidth: 3, outlineColor: [10,5,25,255],
      fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false }, updateTriggers: { getColor: t } }));
  }
  if (S.arc) L.push(new ArcLayer({ id: 'arc', data: [S.arc], getSourcePosition: d => d.from, getTargetPosition: d => d.to, getSourceColor: [255,181,71], getTargetColor: [178,140,255], getWidth: 3, getHeight: 0.6 }));
  if (S.focus) {
    const ph = (t * 0.8) % 1;
    L.push(new ScatterplotLayer({ id: 'focus', data: [S.focus], getPosition: d => d.pos, getRadius: 40 + ph * 260, radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 3, getLineColor: [255,255,255, 255 * (1 - ph)], updateTriggers: { getRadius: ph, getLineColor: ph } }));
    L.push(new TextLayer({ id: 'focus-label', data: [S.focus], getPosition: d => d.pos, getText: d => d.label, getSize: 15, getColor: [255,255,255], getPixelOffset: [0, -30], fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, outlineWidth: 4, outlineColor: [0,0,0,255], fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false } }));
  }
  return L;
}

// ---------- tooltips ----------
function stationTip(s) {
  const b = busy(s), when = `${DAYNAME[S.day].slice(0,3)} ${slotLabel(S.slot)}`;
  const peak = busiestSlot(s, S.day);
  let h = `<b>${esc(s.name)}</b><br><span class="muted">${s.lines.map(l => esc(S.lineIndex[l]?.name || l)).join(' · ')}</span><br>`;
  if (b.kind === 'live') {
    const r = b.live.ratio;
    h += `<span class="${r < 0.85 ? 'cool' : r > 1.15 ? 'hot' : ''}"><b>LIVE ${Math.round(r * 100)}% of typical</b></span> <span class="muted">(TfL live ${b.live.timeLocal})</span><br>`;
    if (b.flow != null) h += `≈ ${n(b.flow)} taps / 15 min now vs ≈ ${n(b.typFlow)} typical<br>`;
  } else if (b.kind === 'typical') {
    h += `<span style="color:#ffb547">TYPICAL ${esc(when)}</span>${b.typFlow != null ? ` · ≈ ${n(b.typFlow)} taps / 15 min` : ''}<br>`;
    if (b.liveRaw) h += `<span class="muted">${b.liveRaw.zero ? 'TfL live reading is 0% (station closed or no data), so typical shown' : 'live reading not comparable at this hour'}</span><br>`;
    else if (S.followNow && s.lu) h += `<span class="muted">${S.crowd.has(s.lu) ? 'no live reading from TfL right now' : 'live reading not fetched yet'}</span><br>`;
  } else {
    h += `<span class="muted">No 15-min profile from TfL for this station.</span><br>${b.daily ? `Typical ${DAYNAME[S.day]}: ${n(b.daily)} entries+exits/day<br>` : ''}`;
  }
  if (peak) h += `<span class="muted">Busiest typical ${DAYNAME[S.day]}: ${slotLabel(peak.slot)}</span>`;
  else if (s.countNote) h += `<span class="muted">${esc(s.countNote)}</span>`;
  return h;
}
function tipHTML(info) {
  const o = info.object, id = info.layer.id;
  if (id === 'pulse-col' || id === 'pulse-daily') return stationTip(o.s);
  if (id === 'line-core') { const li = S.lineIndex[o.id]; return `<b>${esc(li.name)}</b><br><span class="sev-${li.cls}">${esc(li.statuses.map(s => s.desc).join(', ') || 'status unavailable')}</span>`; }
  if (id === 'air-core') return `<b>${esc(o.name)}</b><br>Air quality index <b>${o.index}</b>/10 · ${esc(o.band)}<br><span class="muted">worst pollutant: ${esc(o.worst)}</span>`;
  if (id === 'wiki-burst' || id === 'wiki-seed') return wikiTip(o);
  if (id === 'bikes') return `<b>${esc(o.name)}</b><br>${o.bikes} bikes · ${o.ebikes} e-bikes · ${o.empty} empty`;
  return null;
}
function wikiTip(o) {
  return `<b>${esc(o.title)}</b><br>${o.kind === 'live' ? `edited ${fmtTime(new Date(o.t))} by ${o.bot ? 'a bot' : 'a human'} · <span class="${o.delta >= 0 ? 'sev-good' : 'sev-severe'}">${o.delta >= 0 ? '+' : ''}${o.delta} bytes</span>` : o.kind === 'recent' ? `edited ${fmtTime(new Date(o.t))} (${relDay(o.t)}) by ${esc(o.user)}` : `latest edit ${fmtTime(new Date(o.t))} (${esc(relDay(o.t))}) by ${esc(o.user)}`}<br><span class="muted">click to open the diff</span>`;
}
function relDay(t) { const h = (Date.now() - t) / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : `${Math.round(h)} h ago`; }
overlay.setProps({
  onHover: info => {
    const tip = $('tip'), h = info.object ? tipHTML(info) : null;
    if (!h) { tip.classList.add('hidden'); return; }
    tip.innerHTML = h; tip.classList.remove('hidden');
    tip.style.left = Math.min(info.x + 14, innerWidth - 300) + 'px'; tip.style.top = Math.min(info.y + 14, innerHeight - 140) + 'px';
  },
  onClick: info => {
    if (!info.object) return;
    stopOrbit();
    const o = info.object, id = info.layer.id;
    if (id === 'pulse-col' || id === 'pulse-daily') showStation(o.s);
    else if (id === 'line-core') selectLine(o.id);
    else if (id === 'air-core') showAir(o);
    else if (id === 'wiki-burst' || id === 'wiki-seed') showWiki(o);
  },
});

// ---------- cards ----------
function openCard(html) { if (innerWidth < 760) closeSheets(); $('cardbody').innerHTML = html; $('card').classList.remove('hidden'); }
$('cardx').onclick = () => { $('card').classList.add('hidden'); S.focus = null; S.arc = null; };
function sparkline(s, day) {
  const a = s.prof?.[day]; if (!a) return '';
  const W = 320, H = 80, max = Math.max(0.05, ...a);
  const pts = a.map((v, i) => `${(i / 95 * W).toFixed(1)},${(H - 6 - v / max * (H - 16)).toFixed(1)}`).join(' ');
  const x = S.slot / 95 * W;
  const lv = liveFor(s);
  const liveDot = S.followNow && lv && lv.day === day ? `<circle cx="${(lv.slot / 95 * W).toFixed(1)}" cy="${(H - 6 - lv.pct / max * (H - 16)).toFixed(1)}" r="4" fill="#ff3dbb" stroke="#fff" stroke-width="1"/>` : '';
  const ticks = [0, 24, 48, 72, 95].map(i => `<text x="${Math.min(W - 18, i / 95 * W)}" y="${H}" font-size="8" fill="#8d93a7">${slotLabel(i)}</text>`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H + 2}" preserveAspectRatio="none"><defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffb547" stop-opacity=".5"/><stop offset="1" stop-color="#ffb547" stop-opacity="0"/></linearGradient></defs>
    <polygon points="0,${H - 6} ${pts} ${W},${H - 6}" fill="url(#sg)"/><polyline points="${pts}" fill="none" stroke="#ffb547" stroke-width="1.6"/>
    <line x1="${x}" x2="${x}" y1="0" y2="${H - 6}" stroke="#fff" stroke-opacity=".5" stroke-dasharray="2 2"/>${liveDot}${ticks}</svg>
    <div class="muted">Typical ${DAYNAME[day]} busyness (TfL, % of baseline per 15 min). Dashed line = scrubber${liveDot ? '; pink dot = live reading' : ''}.</div>`;
}
async function showStation(s, extra) {
  S.focus = { pos: s.pos, label: s.name };
  const b = busy(s), peak = busiestSlot(s, S.day);
  const linesHTML = s.lines.map(l => { const li = S.lineIndex[l]; return li ? `<div><span style="color:rgb(${li.col})">●</span> ${esc(li.name)} — <span class="sev-${li.cls}">${esc(li.statuses.map(x => x.desc).join(', ') || '…')}</span></div>` : ''; }).join('');
  const big = b.kind === 'live'
    ? `<div><b class="${b.live.ratio < .85 ? 'cool' : b.live.ratio > 1.15 ? 'hot' : ''}">${Math.round(b.live.ratio * 100)}%</b><span>of typical · live ${b.live.timeLocal}</span></div>${b.flow != null ? `<div><b>≈${n(b.flow)}</b><span>taps/15 min now</span></div>` : ''}`
    : b.kind === 'typical' ? `<div><b style="color:#ffb547">${b.typFlow != null ? '≈' + n(b.typFlow) : Math.round(b.typ * 100) + '%'}</b><span>${b.typFlow != null ? 'taps/15 min' : 'of baseline'} · typical ${slotLabel(S.slot)}</span></div>` : '';
  const head = `<div class="kind">${extra ? '✦ Go here right now' : 'Station pulse'}</div><h2>${esc(s.name)}</h2>
    <div class="big">${big}${b.daily ? `<div><b>${n(b.daily)}</b><span>typical ${DAYNAME[S.day].slice(0,3)} entries+exits</span></div>` : ''}</div>
    ${sparkline(s, S.day)}${peak ? `<p class="muted">Busiest typical ${DAYNAME[S.day]} slot: <b>${slotLabel(peak.slot)}</b>${s.peaks?.[S.day] ? ` · TfL peaks AM ${esc(s.peaks[S.day][0])}, PM ${esc(s.peaks[S.day][1])}` : ''}</p>` : `<p class="muted">TfL publishes no 15-minute profile for this station; size shows the daily count only.</p>`}
    ${extra || ''}${linesHTML}`;
  const foot = `<p class="muted">${s.countRows ? 'Counts: TfL Annual Station Counts 2025 (' + esc(s.countRows.join(', ')) + ')' : esc(s.countNote || 'No TfL count published for this station')}. ≈taps = daily count × this slot's share of TfL's typical profile (estimate).</p>`;
  openCard(head + `<p class="muted">fetching live arrivals…</p>` + foot);
  const stops = (s.stops || []).slice(0, 3);
  try {
    const res = await Promise.allSettled(stops.map(id => gj(`https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(id)}/Arrivals`)));
    const ok = res.filter(r => r.status === 'fulfilled');
    if (!ok.length) throw new Error(res[0]?.reason?.message || 'no response');
    const arr = ok.flatMap(r => r.value).sort((a, b) => a.timeToStation - b.timeToStation).slice(0, 12);
    const rows = arr.map(a => `<tr><td><span style="color:rgb(${(S.lineIndex[a.lineId]?.col || [255,255,255])})">●</span> ${esc(a.lineName)}</td><td>${esc((a.towards || a.destinationName || '').replace(/ (Underground|DLR|Rail) Station$/, ''))}<div class="muted">${esc(a.platformName || '')}</div></td><td>${a.timeToStation < 60 ? 'due' : Math.floor(a.timeToStation / 60) + ' min'}</td></tr>`).join('');
    if ($('card').classList.contains('hidden') || S.focus?.label !== s.name) return;
    openCard(head + `<div class="kind" style="margin-top:10px">Live arrivals · TfL ${fmtTimeS(new Date())}</div>` + (rows ? `<table class="arr">${rows}</table>` : '<p class="muted">TfL is reporting no predicted arrivals here right now.</p>') + foot);
  } catch (e) {
    if (S.focus?.label === s.name) openCard(head + `<p class="sev-severe">Live arrivals feed failed: ${esc(e.message)}</p>` + foot);
  }
}
function showAir(o) {
  S.focus = { pos: [o.lon, o.lat], label: o.name.split(' - ').pop() };
  openCard(`<div class="kind">Air quality monitor · ${esc(o.type)}</div><h2>${esc(o.name)}</h2>
  <div class="big"><div><b style="color:rgb(${airColour(o.index)})">${o.index}</b><span>index /10</span></div><div><b style="font-size:16px;line-height:27px">${esc(o.band)}</b><span>band</span></div></div>
  ${o.species.map(s => `<div>${esc(s.name)} (${esc(s.code)}): <b>${s.index}</b> · ${esc(s.band)}</div>`).join('')}
  <p class="muted">Hourly bulletin ${esc(o.bulletin)} (London) · ${esc(o.borough)} · Daily Air Quality Index, 1 = low, 10 = very high</p>`);
}
function showWiki(o) {
  S.focus = { pos: o.pos, label: o.title };
  map.flyTo({ center: o.pos, zoom: Math.max(map.getZoom(), 14.5), pitch: 60, duration: 2200 });
  openCard(`<div class="kind">Where London is curious · Wikipedia</div><h2>${esc(o.title)}</h2>
    <p>${o.kind === 'live' ? `Edited <b>${fmtTimeS(new Date(o.t))}</b> (London) by ${o.bot ? 'a <b>bot</b>' : 'a <b>human</b>'} (${esc(o.user)}) · <span class="${o.delta >= 0 ? 'sev-good' : 'sev-severe'}">${o.delta >= 0 ? '+' : ''}${o.delta} bytes</span>${o.comment ? `<br><span class="muted">“${esc(o.comment.slice(0, 160))}”</span>` : ''}` : `Latest edit ${fmtTime(new Date(o.t))} (${relDay(o.t)}) by ${esc(o.user)} <span class="muted">(${o.kind === 'recent' ? 'from Wikipedia RecentChanges, before you opened the page' : "seeded from Wikipedia's geosearch, not the live stream"})</span>${o.comment ? `<br><span class="muted">“${esc(o.comment.slice(0, 160))}”</span>` : ''}`}</p>
    <p><a href="${esc(o.diff)}" target="_blank" rel="noopener">See the diff ↗</a> · <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(o.title.replace(/ /g, '_'))}" target="_blank" rel="noopener">Read the article ↗</a></p>`);
}
function selectLine(id) {
  S.selectedLine = S.selectedLine === id ? null : id;
  document.querySelectorAll('.ln').forEach(el => el.classList.toggle('sel', el.dataset.id === S.selectedLine));
  const li = S.lineIndex[id];
  if (S.selectedLine && li?.bounds) {
    map.fitBounds(li.bounds, { padding: { top: 120, bottom: 160, left: 360, right: 350 }, pitch: 50, bearing: map.getBearing() + 20, duration: 2600 });
    openCard(`<div class="kind">Line</div><h2 style="color:rgb(${li.col})">${esc(li.name)}</h2><p class="sev-${li.cls}"><b>${esc(li.statuses.map(s => s.desc).join(', '))}</b></p>${li.statuses.filter(s => s.reason).map(s => `<p>${esc(s.reason)}</p>`).join('')}<p class="muted">click the line again to clear</p>`);
  } else S.focus = null;
}

// ---------- panels ----------
function renderStatus() {
  const box = $('lines');
  if (!S.status) { box.innerHTML = `<p class="sev-severe">Line status feed unavailable${S.errors.status ? ': ' + esc(S.errors.status) : ''}</p>`; return; }
  const order = { severe: 0, minor: 1, good: 2 };
  const ls = S.status.lines.map(l => ({ ...l, cls: classify(l.statuses) })).sort((a, b) => order[a.cls] - order[b.cls] || a.name.localeCompare(b.name));
  box.innerHTML = ls.map(l => `<div class="ln ${l.cls} ${S.selectedLine === l.id ? 'sel' : ''}" data-id="${l.id}" title="${esc(l.statuses.map(s => s.reason || s.desc).join('\n'))}"><i class="sw" style="background:${LINE_COLOURS[l.id] || '#fff'}"></i><span class="nm">${esc(l.name)}</span><span class="sd">${l.statuses.map(s => esc(s.desc)).join('<br>')}</span></div>`).join('');
  box.querySelectorAll('.ln').forEach(el => el.onclick = () => { stopOrbit(); selectLine(el.dataset.id); });
  const bad = ls.filter(l => l.cls !== 'good').length;
  $('st-summary').innerHTML = bad ? `<span class="sev-minor">${bad} disrupted</span> / ${ls.length}` : `<span class="sev-good">all ${ls.length} good</span>`;
}
function renderStats() {
  const lu = S.stations.filter(s => s.lu && s.prof);
  const liveSt = lu.map(s => ({ s, lv: liveFor(s) })).filter(x => x.lv && x.lv.ratio != null);
  $('s-live').textContent = S.crowdChecked ? `${liveSt.length}/${lu.length}` : '…';
  const withFlow = S.stations.map(s => ({ s, b: busy(s) })).filter(x => x.b.flow != null);
  const top = withFlow.sort((a, b) => b.b.flow - a.b.flow)[0];
  $('s-busy').textContent = top ? top.s.name : '–';
  $('s-busy-l').textContent = top ? `busiest ${S.followNow ? 'now' : slotLabel(S.slot)} · ≈${n(top.b.flow)}/15m${top.b.kind === 'live' ? ' live' : ' typical'}` : 'busiest now';
  const quiet = liveSt.filter(x => x.lv.typ >= 0.03).sort((a, b) => a.lv.ratio - b.lv.ratio)[0];
  $('s-quiet').textContent = quiet ? `${quiet.s.name} ${Math.round(quiet.lv.ratio * 100)}%` : (S.crowdChecked ? 'no live yet' : '…');
  const W = S.wiki, mins = Math.max(1, Math.round((Date.now() - W.since) / 60000));
  const hour = Date.now() - 3600e3;
  const lastHour = new Set([...W.bursts, ...W.seeds].filter(o => o.t >= hour && o.kind !== 'seed').map(o => o.title)).size;
  $('s-wiki').textContent = W.recentDone ? `${lastHour} in last hour` : (W.london ? `${W.london} live` : '…');
  $('s-wiki-l').textContent = `London Wikipedia edits`;
  $('s-wiki').parentElement.title = `${W.london} London-geotagged edits live out of ${n(W.seen)} English Wikipedia article edits seen since you opened the page; the hourly count also includes Wikipedia RecentChanges before that`;
  $('s-storm').textContent = S.storm ? S.storm.level : '…';
}
function renderTicker() {
  const W = S.wiki;
  const live = W.bursts.slice(-40).reverse();
  const recent = W.seeds.filter(o => o.kind === 'recent').sort((a, b) => b.t - a.t);
  const seeds = W.seeds.filter(o => o.kind === 'seed').sort((a, b) => b.t - a.t).slice(0, 25);
  const item = (o, fresh) => `<div class="tk ${o.kind} ${fresh ? 'fresh' : ''}" data-k="${esc(o.key)}"><div class="t">${esc(o.title)}</div><div class="m">${fmtTime(new Date(o.t))} · ${o.kind === 'live' ? `<span class="${o.delta >= 0 ? 'p' : 'n'}">${o.delta >= 0 ? '+' : ''}${o.delta}</span> · ${o.bot ? 'bot' : 'human'}` : esc(relDay(o.t))} · <a href="${esc(o.diff)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">diff</a></div></div>`;
  $('ticker').innerHTML = (live.length ? `<div class="sec">Live since you arrived</div>` + live.map((o, i) => item(o, i === 0 && Date.now() - o.t < 5000)).join('') : `<p class="muted" style="margin:4px 6px">${W.connected ? `Listening… ${n(W.seen)} English Wikipedia article edits seen so far, none geotagged inside Greater London yet. It's sparse: typically a handful per hour.` : 'connecting to Wikimedia EventStreams…'}</p>`)
    + (recent.length ? `<div class="sec">Last hour · Wikipedia RecentChanges</div>` + recent.map(o => item(o)).join('') : (W.recentDone ? `<p class="muted" style="margin:4px 6px">No London-geotagged article edits in the last ${W.recentSpan || 60} min of RecentChanges.</p>` : ''))
    + (seeds.length ? `<div class="sec">Earlier · last 24 h (latest revision of nearby articles)</div>` + seeds.map(o => item(o)).join('') : '');
  const all = [...W.bursts, ...W.seeds];
  $('ticker').querySelectorAll('.tk').forEach(el => el.onclick = () => { const o = all.find(x => x.key === el.dataset.k); if (o) { stopOrbit(); showWiki(o); } });
  $('wk-summary').innerHTML = `<span style="color:#b28cff">${W.london} live</span> · ${recent.length} last hr · ${seeds.length} 24 h`;
}
function renderHealth() {
  const lu = S.stations.filter(s => s.lu && s.prof).length;
  const f = [
    ['net', 'Typical crowding', () => S.net && `${S.stations.filter(s => s.prof).length} profiles`],
    ['crowd', 'Live crowding', () => S.crowdChecked && `${S.crowdChecked}/${lu} checked`],
    ['status', 'Line status', () => S.status && `${S.status.lines.length} lines`],
    ['wiki', 'Wikipedia', () => S.wiki.connected && 'streaming'],
    ['air', 'Air', () => S.air && `${S.air.sites.length} sites`],
    ['weather', 'Weather', () => S.weather && 'Open-Meteo'],
    ...(S.show.bikes ? [['bikes', 'Bikes', () => S.bikes && `${S.bikes.length} docks`]] : []),
  ];
  $('health').innerHTML = f.map(([k, label, ok]) => {
    if (S.errors[k]) return `<span class="pill bad" title="${esc(S.errors[k])}">✕ ${label} down</span>`;
    const v = ok(); return v ? `<span class="pill ok">● ${label} · ${v}</span>` : `<span class="pill wait">… ${label}</span>`;
  }).join('') + `<span class="pill info" title="Blitzortung's terms don't allow third-party use of its data, and no open, keyless strike feed exists, so strikes are not shown">⚡ live strikes n/a</span>`;
  const down = Object.entries(S.errors).filter(([, v]) => v);
  const t = $('toast');
  if (down.length) { t.innerHTML = `⚠ Live feed problem — ${down.map(([k, v]) => `<b>${esc({ net: 'typical crowding data', crowd: 'TfL live crowding', status: 'TfL line status', wiki: 'Wikipedia stream', air: 'London Air', weather: 'Open-Meteo weather', bikes: 'TfL bikes' }[k] || k)}</b>: ${esc(v)}`).join(' · ')}. Nothing is invented: affected layers are hidden or stale.`; t.classList.remove('hidden'); }
  else t.classList.add('hidden');
}
function renderLegend() {
  $('legend').innerHTML = `<b>Pulse</b>: column height ≈ station taps per 15 min (TfL 2025 daily count × TfL typical profile); rings beat faster when busier.
    <div class="grad" style="background:linear-gradient(90deg,#78461e,#ffb547,#fff0c8)"></div><span>typical pattern (amber)</span>
    <div class="grad" style="background:linear-gradient(90deg,#2ef2ff,#f0f0ff,#ff3dbb)"></div><div style="display:flex;justify-content:space-between"><span>live: quieter</span><span>usual</span><span>busier</span></div>
    Pink dot = live TfL reading. Grey rings = no 15-min profile (daily count only).<br>
    <b>Curious</b>: violet bursts = English Wikipedia articles geotagged in Greater London, edited live; faint dots = edited in last 24 h.<br>
    Flowing light on lines = good service; slow/flickering red = disruption (visual effect, not trains).`;
}

// ---------- feeds ----------
async function loadStatic() {
  try { S.net = await gj('data/london.json'); prepareNetwork(S.net); S.errors.net = null; }
  catch (e) { S.errors.net = e.message; }
}
async function loadStatus() {
  try {
    const d = await gj('https://api.tfl.gov.uk/Line/Mode/tube,elizabeth-line,dlr,overground/Status');
    S.status = { lines: d.map(l => ({ id: l.id, name: l.name, statuses: (l.lineStatuses || []).map(s => ({ desc: s.statusSeverityDescription, reason: s.reason || null })) })) };
    S.errors.status = null; S.statusAt = new Date(); buildLines();
  } catch (e) { S.errors.status = S.status ? `${e.message}; showing status from ${fmtTime(S.statusAt)}` : e.message; }
}
async function loadAir() {
  try {
    const d = await gj('https://api.erg.ic.ac.uk/AirQuality/Hourly/MonitoringIndex/GroupName=London/Json');
    const sites = [];
    for (const la of [].concat(d?.HourlyAirQualityIndex?.LocalAuthority || [])) for (const s of [].concat(la.Site || [])) {
      const species = [].concat(s.Species || []).map(sp => ({ code: sp['@SpeciesCode'], name: sp['@SpeciesDescription'], index: +sp['@AirQualityIndex'], band: sp['@AirQualityBand'] })).filter(sp => sp.band && sp.band !== 'No data');
      const lat = +s['@Latitude'], lon = +s['@Longitude'];
      if (!species.length || !lat || !lon) continue;
      const worst = species.reduce((a, b) => (b.index > a.index ? b : a));
      sites.push({ name: s['@SiteName'], type: s['@SiteType'], borough: la['@LocalAuthorityName'], lat, lon, bulletin: s['@BulletinDate'], index: worst.index, band: worst.band, worst: worst.code, species });
    }
    S.air = { sites }; S.errors.air = null;
  } catch (e) { S.errors.air = e.message; }
}
async function loadBikes() {
  try {
    const d = await gj('https://api.tfl.gov.uk/BikePoint');
    S.bikes = d.map(p => { const a = Object.fromEntries((p.additionalProperties || []).map(x => [x.key, x.value])); return { name: p.commonName, lat: p.lat, lon: p.lon, bikes: +a.NbBikes || 0, ebikes: +a.NbEBikes || 0, empty: +a.NbEmptyDocks || 0 }; });
    S.errors.bikes = null;
  } catch (e) { S.errors.bikes = e.message; }
}

// live crowding: polite batched sweep over Underground stations, busiest first; restarts every ~10 min
let crowdQueue = [], crowdTimer = null;
function crowdSweep() {
  crowdQueue = S.stations.filter(s => s.lu && s.prof).sort((a, b) => (b.daily?.midweek || 0) - (a.daily?.midweek || 0)).map(s => s.lu);
}
async function crowdTick() {
  if (document.hidden || Date.now() < S.crowdBackoff) return;
  if (!crowdQueue.length) return;
  const batch = crowdQueue.splice(0, 1);
  await Promise.all(batch.map(async id => {
    try { const d = await gj(`https://api.tfl.gov.uk/crowding/${id}/Live`); S.crowd.set(id, d); S.crowdChecked = Math.max(S.crowdChecked, S.crowd.size); S.errors.crowd = null; }
    catch (e) { S.crowdErrors++; if (e.rate) { S.crowdBackoff = Date.now() + 60000; crowdQueue.unshift(id); } if (S.crowdErrors > 8 && S.crowd.size === 0) S.errors.crowd = e.message; }
  }));
}
// TfL's anonymous limit is shared by every call from this browser, so: one live-crowding request every 2.5 s (≈24/min),
// a new sweep once the previous one is done and 10 min have passed, and a 60 s pause on HTTP 429.
let sweepAt = 0;
function startCrowd() { crowdSweep(); sweepAt = Date.now(); crowdTimer = setInterval(() => { if (!crowdQueue.length && Date.now() - sweepAt > 10 * 60e3) { crowdSweep(); sweepAt = Date.now(); } crowdTick(); }, 2500); }

// ---------- Wikipedia: live stream + coordinate lookups + seeds ----------
function startWiki() {
  const W = S.wiki;
  // Read the SSE stream with fetch (resumes with ?since= after a dropped connection, so no gap and no noisy reconnects)
  let lastDt = null;
  const handle = d => {
    if (d.meta?.dt) lastDt = d.meta.dt;
    if (d.wiki !== 'enwiki' || d.namespace !== 0 || (d.type !== 'edit' && d.type !== 'new')) return;
    W.seen++; W.pending.set(d.title, d);
  };
  (async function loop() {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch('https://stream.wikimedia.org/v2/stream/recentchange' + (lastDt ? '?since=' + encodeURIComponent(lastDt) : ''), { headers: { Accept: 'text/event-stream' }, cache: 'no-store' });
        if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
        W.connected = true; S.errors.wiki = null; attempt = 0;
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await rd.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (line.startsWith('data: ')) { try { handle(JSON.parse(line.slice(6))); } catch {} }
          }
        }
      } catch (e) { if (attempt > 2) S.errors.wiki = 'stream unavailable (' + e.message + '), retrying'; }
      W.connected = false;
      await new Promise(r => setTimeout(r, Math.min(30000, 2000 * (attempt + 1))));
    }
  })();
  setInterval(async () => {
    if (!W.pending.size) return;
    const evs = [...W.pending.values()].slice(0, 50);
    evs.forEach(e => W.pending.delete(e.title));
    const unknown = evs.filter(e => !W.cache.has(e.title));
    if (unknown.length) {
      try {
        const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&prop=coordinates&coprimary=primary&colimit=max&titles=' + encodeURIComponent(unknown.map(e => e.title).join('|'));
        const d = await gj(u); W.lookups++;
        const norm = Object.fromEntries((d.query?.normalized || []).map(x => [x.to, x.from]));
        unknown.forEach(e => W.cache.set(e.title, null));
        for (const p of d.query?.pages || []) { const c = p.coordinates?.[0]; const key = norm[p.title] || p.title; if (c && c.globe === 'earth') W.cache.set(key, [c.lon, c.lat]); }
        S.errors.wikicoords = null;
      } catch (e) { evs.forEach(x => W.pending.set(x.title, x)); return; }
    }
    for (const e of evs) {
      const pos = W.cache.get(e.title);
      if (!pos || !inLondon(pos[0], pos[1])) continue;
      W.london++;
      const b = { kind: 'live', key: 'L' + e.id, title: e.title, pos, t: Date.parse(e.meta?.dt) || Date.now(), user: e.user, bot: !!e.bot, delta: (e.length?.new || 0) - (e.length?.old || 0), comment: e.comment,
        diff: e.revision?.old ? `https://en.wikipedia.org/w/index.php?diff=${e.revision.new}&oldid=${e.revision.old}` : `https://en.wikipedia.org/w/index.php?oldid=${e.revision?.new}` };
      W.bursts.push(b); if (W.bursts.length > 300) W.bursts.shift();
      onBurst(b);
    }
    renderTicker(); renderStats();
  }, 8000);
}
async function seedWiki() {
  const W = S.wiki, centres = [[51.5074,-0.1278],[51.585,-0.12],[51.43,-0.11],[51.52,0.04],[51.5,-0.29],[51.6,-0.33],[51.42,0.09],[51.4,-0.27],[51.6,0.07],[51.53,-0.42],[51.36,-0.06]];
  const seen = new Set(), cutoff = Date.now() - 24 * 3600e3;
  for (const [lat, lon] of centres) {
    try {
      const d = await gj(`https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&generator=geosearch&ggscoord=${lat}|${lon}&ggsradius=10000&ggslimit=500&prop=coordinates|revisions&colimit=max&rvprop=timestamp|user|ids`);
      for (const p of d.query?.pages || []) {
        const r = p.revisions?.[0], c = p.coordinates?.[0];
        if (!r || !c || seen.has(p.pageid)) continue;
        const t = Date.parse(r.timestamp);
        if (t < cutoff || !inLondon(c.lon, c.lat) || W.seeds.some(x => x.title === p.title)) continue;
        seen.add(p.pageid);
        W.seeds.push({ kind: 'seed', key: 'S' + p.pageid, title: p.title, pos: [c.lon, c.lat], t, user: r.user, diff: r.parentid ? `https://en.wikipedia.org/w/index.php?diff=${r.revid}&oldid=${r.parentid}` : `https://en.wikipedia.org/w/index.php?oldid=${r.revid}` });
      }
    } catch (e) { S.errors.wikiseed = null; }
    await new Promise(r => setTimeout(r, 250));
  }
  renderTicker();
}
// Backfill the last ~60 min of English Wikipedia article edits (RecentChanges), keep the ones geotagged in Greater London
async function seedRecent() {
  const W = S.wiki, cutoff = Date.now() - 60 * 60e3, london = new Map();
  let cont = null, reached = Date.now();
  for (let i = 0; i < 12 && reached > cutoff; i++) {
    try {
      const d = await gj('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&generator=recentchanges&grcnamespace=0&grctype=edit|new&grclimit=500&prop=coordinates&colimit=max&coprimary=primary' + (cont ? '&grccontinue=' + encodeURIComponent(cont) : ''));
      for (const p of d.query?.pages || []) { const c = p.coordinates?.[0]; if (c && inLondon(c.lon, c.lat)) london.set(p.title, [c.lon, c.lat]); }
      cont = d.continue?.grccontinue; if (!cont) break;
      const ts = cont.split('|')[0]; reached = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14));
    } catch (e) { break; }
  }
  W.recentSpan = Math.round((Date.now() - reached) / 60000);
  const titles = [...london.keys()];
  for (let i = 0; i < titles.length; i += 50) {
    try {
      const d = await gj('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&prop=revisions&rvprop=ids|timestamp|user|comment|size&titles=' + encodeURIComponent(titles.slice(i, i + 50).join('|')));
      for (const p of d.query?.pages || []) {
        const r = p.revisions?.[0]; if (!r) continue;
        const t = Date.parse(r.timestamp); if (t < cutoff) continue;
        W.seeds = W.seeds.filter(x => x.title !== p.title);
        W.seeds.push({ kind: 'recent', key: 'R' + r.revid, title: p.title, pos: london.get(p.title), t, user: r.user, comment: r.comment,
          diff: r.parentid ? `https://en.wikipedia.org/w/index.php?diff=${r.revid}&oldid=${r.parentid}` : `https://en.wikipedia.org/w/index.php?oldid=${r.revid}` });
      }
    } catch (e) {}
  }
  W.recentDone = true; renderTicker(); renderStats();
}
let lastAmbientHop = 0;
function onBurst(b) {
  if (S.orbit && Date.now() - lastAmbientHop > 20000) {
    lastAmbientHop = Date.now(); S.focus = { pos: b.pos, label: b.title };
    map.flyTo({ center: b.pos, zoom: 14.2, pitch: 62, duration: 6000, essential: true });
  }
}

// ---------- weather + atmosphere ----------
const WMO = { 0:'Clear sky', 1:'Mainly clear', 2:'Partly cloudy', 3:'Overcast', 45:'Fog', 48:'Rime fog', 51:'Light drizzle', 53:'Drizzle', 55:'Dense drizzle', 56:'Freezing drizzle', 57:'Freezing drizzle', 61:'Light rain', 63:'Rain', 65:'Heavy rain', 66:'Freezing rain', 67:'Freezing rain', 71:'Light snow', 73:'Snow', 75:'Heavy snow', 77:'Snow grains', 80:'Light showers', 81:'Showers', 82:'Violent showers', 85:'Snow showers', 86:'Heavy snow showers', 95:'Thunderstorm', 96:'Thunderstorm, hail', 99:'Thunderstorm, heavy hail' };
const compass = d => ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d / 22.5) % 16];
async function loadWeather() {
  try {
    const w = await gj('https://api.open-meteo.com/v1/forecast?latitude=51.5074&longitude=-0.1278&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,cloud_cover,visibility,precipitation,rain,showers,snowfall,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,cape&hourly=weather_code,cape&daily=sunrise,sunset&timezone=Europe%2FLondon&forecast_days=2&wind_speed_unit=mph');
    S.weather = w; S.errors.weather = null;
    let lp = null;
    try { const s = await gj('https://api.open-meteo.com/v1/forecast?latitude=51.5074&longitude=-0.1278&hourly=lightning_potential&models=icon_seamless&timezone=Europe%2FLondon&forecast_days=2'); lp = s.hourly; } catch (e) {}
    // storm risk: thunderstorm weather codes now / next 6 h, CAPE and ICON lightning potential (no live strikes)
    const now = londonNow(); const today = w.hourly.time.findIndex(t => +t.slice(11, 13) === Math.floor(now.mins / 60) && t.slice(0, 10) === w.current.time.slice(0, 10));
    const i0 = Math.max(0, today), win = k => w.hourly[k].slice(i0, i0 + 7).filter(v => v != null);
    const codes = win('weather_code'), capeMax = Math.max(w.current.cape ?? 0, ...win('cape'));
    const lpMax = lp ? Math.max(0, ...lp.lightning_potential.slice(i0, i0 + 7).filter(v => v != null)) : null;
    const thunderNow = [95, 96, 99].includes(w.current.weather_code), thunderSoon = codes.some(c => c >= 95);
    const level = thunderNow ? 'THUNDER NOW' : thunderSoon ? 'thunder forecast' : (capeMax > 1000 || (lpMax ?? 0) > 100) ? 'elevated' : (capeMax > 300 || (lpMax ?? 0) > 0) ? 'low' : 'very low';
    S.storm = { level, capeMax, lpMax, thunderSoon, thunderNow };
    applyAtmosphere();
  } catch (e) { S.errors.weather = e.message; }
}
function sunElevation(date, lat = 51.5074, lon = -0.1278) {
  const rad = Math.PI / 180, d = date / 86400000 - 10957.5; // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24, ha = ((gmst * 15 + lon) * rad - ra);
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}
function renderWeatherChip() {
  const w = S.weather;
  if (!w) { $('wx').innerHTML = S.errors.weather ? `<span class="sev-severe">Weather feed down: ${esc(S.errors.weather)}</span>` : 'weather loading…'; return; }
  const c = w.current, el = sunElevation(Date.now());
  const sr = w.daily.sunrise.map(x => x.slice(11)), ss = w.daily.sunset.map(x => x.slice(11));
  const sunTxt = el > 0 ? `☀ up ${el.toFixed(0)}° · sunset ${ss[0]}` : el > -6 ? `twilight · sun ${el.toFixed(0)}°` : `night · sunrise ${new Date().getHours() < 12 ? sr[0] : sr[1]}`;
  const precip = c.precipitation > 0 ? ` · ${c.precipitation} mm in last 15 min` : '';
  const st = S.storm;
  $('wx').innerHTML = `<span class="big">${Math.round(c.temperature_2m)}°C</span>${esc(WMO[c.weather_code] || 'code ' + c.weather_code)}${precip}
    <div class="muted wx2">feels ${Math.round(c.apparent_temperature)}° · wind ${compass(c.wind_direction_10m)} ${Math.round(c.wind_speed_10m)} mph (gust ${Math.round(c.wind_gusts_10m)}) · vis ${(c.visibility / 1000).toFixed(c.visibility < 10000 ? 1 : 0)} km · cloud ${c.cloud_cover}% · ${sunTxt}</div>
    <div class="muted">⚡ storm risk <b style="color:#ffb547">${st ? esc(st.level) : '…'}</b><span class="wx2">${st ? ` · CAPE ≤${Math.round(st.capeMax)} J/kg next 6 h${st.lpMax != null ? ` · ICON lightning potential ≤${st.lpMax.toFixed(1)} J/kg` : ''}` : ''}</span> · live strikes not available</div>
    <div class="muted wx2">Open-Meteo, London, ${esc(c.time.slice(11))} (London)</div>`;
}
const rainCanvas = $('precip'), rctx = rainCanvas.getContext('2d');
let drops = [], precipMode = null;
function applyAtmosphere() {
  renderWeatherChip();
  const w = S.weather, on = S.show.weather;
  const el = sunElevation(Date.now());
  // sky colours from the real sun elevation
  const night = { sky: '#03050d', hor: '#141a33', fog: '#0a0e1c' }, twi = { sky: '#141235', hor: '#c2614a', fog: '#2a1f35' }, gold = { sky: '#2a3561', hor: '#f0a060', fog: '#4a4058' }, day = { sky: '#22385e', hor: '#7d9cc4', fog: '#53647f' };
  const pal = el < -6 ? night : el < 0 ? twi : el < 8 ? gold : day;
  const c = w?.current;
  const vis = c ? c.visibility : 20000, cloud = c ? c.cloud_cover : 0;
  const fogBlend = !on ? 0.9 : vis < 1000 ? 0.15 : vis < 4000 ? 0.4 : vis < 10000 ? 0.65 : 0.85 - cloud / 1000;
  if (mapReady) {
    try { map.setSky({ 'sky-color': pal.sky, 'horizon-color': pal.hor, 'fog-color': pal.fog, 'sky-horizon-blend': 0.6, 'horizon-fog-blend': on ? 0.6 : 0.9, 'fog-ground-blend': fogBlend, 'atmosphere-blend': 0.6 }); } catch (e) {}
    try { map.setLight({ anchor: 'map', color: el > 0 ? '#ffe6c4' : '#9fb4ff', intensity: el > 0 ? 0.45 : 0.3, position: [1.5, 200, 40] }); } catch (e) {}
  }
  const haze = $('haze');
  if (on && c) {
    const strength = Math.min(0.55, (vis < 10000 ? (10000 - vis) / 10000 * 0.45 : 0) + cloud / 100 * 0.12);
    haze.style.opacity = strength.toFixed(2);
    haze.style.background = `linear-gradient(180deg, ${pal.fog}ee 0%, ${pal.fog}55 45%, transparent 85%)`;
  } else haze.style.opacity = 0;
  // particles only when it's actually precipitating right now
  precipMode = null;
  if (on && c) {
    const snow = c.snowfall > 0, wet = (c.rain || 0) + (c.showers || 0) + (c.precipitation || 0) > 0;
    if (snow) precipMode = { type: 'snow', rate: c.snowfall * 4 };
    else if (wet) precipMode = { type: 'rain', rate: Math.max(c.precipitation, c.rain + c.showers) * 4 }; // mm/h from the 15-min sum
  }
  const want = precipMode ? Math.round(Math.min(700, (precipMode.type === 'snow' ? 120 : 90) + precipMode.rate * 160)) : 0;
  drops = Array.from({ length: want }, () => ({ x: Math.random(), y: Math.random(), z: 0.4 + Math.random() * 0.6 }));
}
function drawPrecip(dt) {
  const W = rainCanvas.clientWidth, H = rainCanvas.clientHeight;
  if (rainCanvas.width !== W || rainCanvas.height !== H) { rainCanvas.width = W; rainCanvas.height = H; }
  rctx.clearRect(0, 0, W, H);
  if (!precipMode || !drops.length) return;
  const c = S.weather.current;
  const ang = ((c.wind_direction_10m + 180 - map.getBearing()) % 360) * Math.PI / 180;
  const drift = Math.sin(ang) * Math.min(1, c.wind_speed_10m / 25);
  if (precipMode.type === 'rain') {
    rctx.strokeStyle = 'rgba(175,195,235,0.42)'; rctx.lineWidth = 1; rctx.beginPath();
    for (const d of drops) {
      d.y += dt * 1.6 * d.z; d.x += dt * drift * 0.5 * d.z;
      if (d.y > 1) { d.y -= 1; d.x = Math.random(); } if (d.x > 1) d.x -= 1; if (d.x < 0) d.x += 1;
      const x = d.x * W, y = d.y * H; rctx.moveTo(x, y); rctx.lineTo(x - drift * 10 * d.z, y - 16 * d.z);
    }
    rctx.stroke();
  } else {
    rctx.fillStyle = 'rgba(240,245,255,0.75)';
    for (const d of drops) {
      d.y += dt * 0.12 * d.z; d.x += dt * (drift * 0.15 + Math.sin(d.y * 20 + d.z * 9) * 0.02);
      if (d.y > 1) { d.y -= 1; d.x = Math.random(); } if (d.x > 1) d.x -= 1; if (d.x < 0) d.x += 1;
      rctx.beginPath(); rctx.arc(d.x * W, d.y * H, 1.6 * d.z, 0, 6.283); rctx.fill();
    }
  }
}

// ---------- time scrubber ----------
const daySel = $('day');
daySel.innerHTML = DAYS.map(d => `<option value="${d}">${DAYNAME[d].slice(0, 3)}</option>`).join('');
function syncNow() { const t = londonNow(); S.day = t.day; S.slot = t.slot; }
function renderScrub() {
  daySel.value = S.day; $('slot').value = S.slot; $('ttime').textContent = slotLabel(S.slot);
  const tm = $('tmode'); tm.textContent = S.followNow ? 'LIVE' : 'TYPICAL'; tm.className = 'tag ' + (S.followNow ? 'live' : 'typ');
  $('play').textContent = S.playing ? '❚❚' : '▶'; $('play').classList.toggle('on', S.playing);
}
$('slot').oninput = e => { S.slot = +e.target.value; S.followNow = false; renderScrub(); renderStats(); };
daySel.onchange = e => { S.day = e.target.value; S.followNow = false; renderScrub(); renderStats(); };
$('now').onclick = () => { S.followNow = true; S.playing = false; syncNow(); renderScrub(); renderStats(); };
let playTimer = null;
$('play').onclick = () => {
  S.playing = !S.playing; S.followNow = false;
  clearInterval(playTimer);
  if (S.playing) playTimer = setInterval(() => { S.slot++; if (S.slot > 95) { S.slot = 0; S.day = DAYS[(DAYS.indexOf(S.day) + 1) % 7]; } renderScrub(); renderStats(); }, 380);
  renderScrub();
};

// ---------- refresh ----------
let lastSlow = 0;
async function refresh(initial, force) {
  $('refresh').classList.add('spin');
  if (S.followNow) syncNow();
  const slow = initial || force || Date.now() - lastSlow > 10 * 60e3; // air (hourly bulletin) and weather (15-min) every 10 min
  if (slow) lastSlow = Date.now();
  await Promise.allSettled([loadStatus(), slow ? loadAir() : null, slow ? loadWeather() : null, S.show.bikes ? loadBikes() : null]);
  S.lastUpdate = new Date(); S.nextAt = Date.now() + REFRESH_MS;
  $('updated').textContent = fmtTime(S.lastUpdate);
  $('refresh').classList.remove('spin');
  renderStatus(); renderStats(); renderHealth(); renderScrub(); renderWeatherChip();
}
$('refresh').onclick = () => { crowdSweep(); refresh(false, true); };
setInterval(() => {
  $('clock').textContent = fmtTime(new Date());
  const left = Math.max(0, S.nextAt - Date.now());
  $('ring').style.strokeDashoffset = (94.25 * (1 - left / REFRESH_MS)).toFixed(1);
  if (S.followNow) { const t = londonNow(); if (t.slot !== S.slot || t.day !== S.day) { S.day = t.day; S.slot = t.slot; renderScrub(); } }
  renderHealth(); renderStats();
  if (S.nextAt && left === 0 && !document.hidden) { S.nextAt = Date.now() + REFRESH_MS; refresh(); }
}, 1000);
setInterval(() => renderTicker(), 30000);

// ---------- controls ----------
const toggles = { pulse: 'L-pulse', wiki: 'L-wiki', tube: 'L-tube', air: 'L-air' };
Object.entries(toggles).forEach(([k, id]) => $(id).onchange = e => { S.show[k] = e.target.checked; });
$('L-weather').onchange = e => { S.show.weather = e.target.checked; applyAtmosphere(); };
$('L-bikes').onchange = async e => { S.show.bikes = e.target.checked; if (S.show.bikes && !S.bikes) { await loadBikes(); renderHealth(); } };
$('L-buildings').onchange = e => { if (map.getLayer('3d-buildings')) map.setLayoutProperty('3d-buildings', 'visibility', e.target.checked ? 'visible' : 'none'); };
$('home').onclick = () => { stopOrbit(); S.selectedLine = null; S.focus = null; S.arc = null; renderStatus(); $('card').classList.add('hidden'); map.flyTo({ ...HOME, duration: 3000 }); };
function startOrbit() { S.orbit = true; $('orbit').classList.add('on'); }
function stopOrbit() { S.orbit = false; $('orbit').classList.remove('on'); }
$('orbit').onclick = () => S.orbit ? stopOrbit() : (startOrbit(), lastAmbientHop = 0, map.easeTo({ pitch: 62, duration: 1500 }));
map.on('mousedown', stopOrbit); map.on('touchstart', stopOrbit); map.on('wheel', stopOrbit);
const sheet = (btn, id, other) => $(btn).onclick = () => { $(other).classList.remove('open'); $('card').classList.add('hidden'); $(id).classList.toggle('open'); };
sheet('mLayers', 'layers', 'right'); sheet('mRight', 'right', 'layers');
function closeSheets() { $('layers').classList.remove('open'); $('right').classList.remove('open'); }

// ---------- "Where should I go right now?" ----------
// A station that's unusually quiet vs its typical crowd right now (live TfL), on lines with good service,
// paired with the nearest place London is curious about on Wikipedia, in the actual current weather.
async function suggest() {
  stopOrbit();
  if (!S.followNow) { S.followNow = true; S.playing = false; clearInterval(playTimer); syncNow(); renderScrub(); }
  const cand = S.stations.filter(s => s.lu && s.prof).map(s => ({ s, lv: liveFor(s) }))
    .filter(x => x.lv && x.lv.ratio != null && x.lv.typ >= 0.03 && (x.s.daily?.midweek || 0) >= 15000)
    .map(x => ({ ...x, good: x.s.lines.every(l => S.lineIndex[l]?.cls === 'good') }));
  let basis = 'live';
  let pool = cand.filter(x => x.good).sort((a, b) => a.lv.ratio - b.lv.ratio);
  if (!pool.length) pool = cand.sort((a, b) => a.lv.ratio - b.lv.ratio);
  if (!pool.length) { // no live readings yet: quietest right now relative to the station's own busiest typical slot
    basis = 'typical';
    pool = S.stations.filter(s => s.prof?.[S.day]).map(s => { const pk = busiestSlot(s, S.day); return { s, rel: pk.pct ? s.prof[S.day][S.slot] / pk.pct : 1, good: s.lines.every(l => S.lineIndex[l]?.cls === 'good') }; })
      .filter(x => x.good && (x.s.daily?.midweek || 0) > 20000).sort((a, b) => a.rel - b.rel);
  }
  if (!pool.length) { openCard('<p>Not enough live data has arrived yet. Give it a few seconds and try again.</p>'); return; }
  const top = pool.slice(0, 6), pick = top[Math.floor(Math.random() * top.length)], s = pick.s;
  // nearest curiosity: live burst > 24 h seed > nearby Wikipedia article (geosearch)
  const near = arr => arr.map(o => ({ o, d: metres(s.pos, o.pos) })).filter(x => x.d < 2500).sort((a, b) => a.d - b.d)[0];
  let cur = near(S.wiki.bursts) || near(S.wiki.seeds), curTxt = '';
  if (cur) curTxt = `<li>London is curious nearby: <b>${esc(cur.o.title)}</b> (${Math.round(cur.d)} m), ${cur.o.kind === 'live' ? `edited ${fmtTime(new Date(cur.o.t))} by a ${cur.o.bot ? 'bot' : 'human'}` : `edited ${relDay(cur.o.t)}`} on Wikipedia</li>`;
  else {
    try {
      const d = await gj(`https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&list=geosearch&gscoord=${s.lat}|${s.lon}&gsradius=1500&gslimit=20`);
      const g = (d.query?.geosearch || []).filter(x => !/station|tube|railway|line\b|bus route/i.test(x.title)); const p = g[Math.floor(Math.random() * Math.min(8, g.length))];
      if (p) { cur = { o: { title: p.title, pos: [p.lon, p.lat] }, d: p.dist }; curTxt = `<li>Nearby on Wikipedia: <b><a href="https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}" target="_blank" rel="noopener">${esc(p.title)}</a></b> (${Math.round(p.dist)} m). No live London edits near here yet</li>`; }
    } catch (e) {}
  }
  const w = S.weather?.current;
  const wxTxt = w ? `<li>Weather right now: ${Math.round(w.temperature_2m)}°C, ${esc((WMO[w.weather_code] || '').toLowerCase())}${w.precipitation > 0 ? ` (${w.precipitation} mm in the last 15 min). ${pick.s.lines.length ? 'Ride underground and pop up next to it' : 'Bring a brolly'}` : '. Dry enough to wander'}, wind ${Math.round(w.wind_speed_10m)} mph</li>` : '';
  const quietTxt = basis === 'live'
    ? `<li><b class="cool">${Math.round(pick.lv.ratio * 100)}% of its usual ${DAYNAME[pick.lv.day]} ${slotLabel(pick.lv.slot)} crowd</b>, according to TfL's live reading at ${pick.lv.timeLocal}${pick.lv.ratio < 0.8 ? ': unusually quiet' : pick.lv.ratio < 1 ? ': a little quieter than usual' : ' (nowhere is quieter than usual right now)'}</li>`
    : `<li>No live TfL readings yet. On a typical ${DAYNAME[S.day]} it's at <b>${Math.round(pick.rel * 100)}%</b> of its own busiest slot right now (typical pattern, not live)</li>`;
  const linesTxt = `<li>${s.lines.map(l => esc(S.lineIndex[l]?.name || l)).join(', ')}: <span class="sev-${pick.good ? 'good' : 'minor'}">${pick.good ? 'good service' : 'check status'}</span></li>`;
  const rank = `<li class="muted">Picked at random from the ${top.length} ${basis === 'live' ? 'most unusually quiet live stations' : 'quietest typical stations'} (of ${pool.length})</li>`;
  const missions = ['Find the place below, and look for the detail someone just changed.', 'Walk there without your phone map. Use the skyline.', 'Read the article on the way, then find one thing it gets wrong.', 'Take a photo that would improve that Wikipedia article.', 'Ask a local what they know about it.'];
  const extra = `<div class="kind" style="margin-top:8px">Why here, why now</div><ul class="why">${quietTxt}${linesTxt}${curTxt}${wxTxt}${rank}</ul>${cur ? `<div class="mission">✦ ${missions[Math.floor(Math.random() * missions.length)]}</div>` : ''}`;
  S.arc = cur ? { from: s.pos, to: cur.o.pos } : null;
  map.flyTo({ center: cur ? [(s.pos[0] + cur.o.pos[0]) / 2, (s.pos[1] + cur.o.pos[1]) / 2] : s.pos, zoom: 15.2, pitch: 64, bearing: map.getBearing() + 120 + Math.random() * 120, duration: 5200, curve: 1.8, essential: true });
  showStation(s, extra);
  map.once('moveend', () => { if (!S.orbit) startOrbit(); });
}
$('go').onclick = suggest;

// ---------- animation loop ----------
const t0 = performance.now();
let last = performance.now();
function frame(now) {
  const t = (now - t0) / 1000, dt = Math.min(0.1, (now - last) / 1000);
  if (S.orbit && !map.isMoving()) map.setBearing(map.getBearing() + dt * 4);
  last = now;
  overlay.setProps({ layers: layers(t) });
  drawPrecip(dt);
  requestAnimationFrame(frame);
}

// ---------- boot ----------
(async () => {
  syncNow(); renderScrub(); renderLegend();
  await loadStatic();
  await refresh(true);
  $('loading').classList.add('fade'); setTimeout(() => $('loading').remove(), 1100);
  requestAnimationFrame(frame);
  if (S.net) startCrowd();
  startWiki(); seedRecent().then(seedWiki);
  setInterval(applyAtmosphere, 5 * 60e3); // sun moves
})();
})();
