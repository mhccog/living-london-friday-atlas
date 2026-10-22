/* Living London — live TfL + London Air on a cinematic 3D map. All numbers come from live feeds. */
(() => {
const { MapboxOverlay, ColumnLayer, PathLayer, ScatterplotLayer, TripsLayer, TextLayer } = deck;
const TZ = 'Europe/London';
const HOME = { center: [-0.1, 51.509], zoom: 12.1, pitch: 58, bearing: -17 };
const REFRESH_MS = 60000;

// Official TfL line colours (a few lifted slightly so they read on a black map)
const LINE_COLOURS = {
  bakerloo:'#B36305', central:'#E32017', circle:'#FFD300', district:'#00A03A', 'hammersmith-city':'#F3A9BB',
  jubilee:'#A0A5A9', metropolitan:'#B5006A', northern:'#EDEDED', piccadilly:'#2A62E8', victoria:'#0098D4',
  'waterloo-city':'#95CDBA', elizabeth:'#8A6CD4', dlr:'#00A4A7', liberty:'#9EA2A4', lioness:'#FAA61A',
  mildmay:'#1E90D0', suffragette:'#5BBD72', weaver:'#B8558A', windrush:'#ED1B00'
};
const hex = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];

const S = {
  bikes: null, prevBikes: null, changed: new Map(), status: null, lines: null, air: null,
  errors: {}, show: { bikes:true, tube:true, stations:true, air:true, buildings:true },
  bikeMode: 'ebike', selectedLine: null, focus: null, hover: null, orbit: false, lastUpdate: null, nextAt: 0,
};

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const fmtTime = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);
const fmtTimeS = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const n = x => Number(x).toLocaleString('en-GB');
function metres(a, b) { // [lon,lat]
  const k = Math.PI / 180, x = (b[0]-a[0]) * Math.cos((a[1]+b[1]) / 2 * k), y = b[1]-a[1];
  return Math.sqrt(x*x + y*y) * 111320;
}
function classify(statuses) {
  const d = (statuses || []).map(s => s.desc);
  if (!d.length) return 'good';
  if (d.some(x => /Severe|Suspended|Closed|Closure|Not Running/i.test(x))) return 'severe';
  if (d.some(x => !/Good Service|No Issues|Information|No Step Free/i.test(x))) return 'minor';
  return 'good';
}
// Direct-from-browser fallbacks (all upstream feeds send CORS *), so the same files also work on any static host.
const LINE_IDS = Object.keys(LINE_COLOURS);
const gj = async u => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(u.split('/').slice(2,4).join('/') + ' HTTP ' + r.status); return r.json(); };
const direct = {
  async bikes() {
    const d = await gj('https://api.tfl.gov.uk/BikePoint');
    return { fetchedAt: new Date().toISOString(), docks: d.map(p => {
      const a = Object.fromEntries((p.additionalProperties || []).map(x => [x.key, x.value]));
      const mods = (p.additionalProperties || []).map(x => x.modified).filter(Boolean).sort();
      return { id: p.id, name: p.commonName, lat: p.lat, lon: p.lon, bikes: +a.NbBikes || 0, ebikes: +a.NbEBikes || 0, standard: +a.NbStandardBikes || 0,
        empty: +a.NbEmptyDocks || 0, docks: +a.NbDocks || 0, locked: a.Locked === 'true', installed: a.Installed !== 'false', modified: mods[mods.length - 1] || null };
    }).filter(x => x.lat && x.lon) };
  },
  async status() {
    const d = await gj('https://api.tfl.gov.uk/Line/Mode/tube,elizabeth-line,dlr,overground/Status');
    return { fetchedAt: new Date().toISOString(), lines: d.map(l => ({ id: l.id, name: l.name, mode: l.modeName, statuses: (l.lineStatuses || []).map(s => ({ severity: s.statusSeverity, desc: s.statusSeverityDescription, reason: s.reason || null })) })) };
  },
  async lines() {
    const lines = await Promise.all(LINE_IDS.map(async id => {
      try { const d = await gj(`https://api.tfl.gov.uk/Line/${id}/Route/Sequence/all`);
        return { id, name: d.lineName, paths: (d.lineStrings || []).flatMap(s => { try { return JSON.parse(s); } catch { return []; } }), stations: (d.stations || []).map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })) };
      } catch (e) { return { id, error: e.message, paths: [], stations: [] }; }
    }));
    return { fetchedAt: new Date().toISOString(), lines };
  },
  async air() {
    const d = await gj('https://api.erg.ic.ac.uk/AirQuality/Hourly/MonitoringIndex/GroupName=London/Json');
    const sites = [];
    for (const la of [].concat(d?.HourlyAirQualityIndex?.LocalAuthority || [])) for (const s of [].concat(la.Site || [])) {
      const species = [].concat(s.Species || []).map(sp => ({ code: sp['@SpeciesCode'], name: sp['@SpeciesDescription'], index: +sp['@AirQualityIndex'], band: sp['@AirQualityBand'] })).filter(sp => sp.band && sp.band !== 'No data');
      const lat = +s['@Latitude'], lon = +s['@Longitude'];
      if (!species.length || !lat || !lon) continue;
      const worst = species.reduce((a, b) => (b.index > a.index ? b : a));
      sites.push({ code: s['@SiteCode'], name: s['@SiteName'], type: s['@SiteType'], borough: la['@LocalAuthorityName'], lat, lon, bulletin: s['@BulletinDate'], index: worst.index, band: worst.band, worst: worst.code, species });
    }
    return { fetchedAt: new Date().toISOString(), sites };
  },
  async arrivals(id) {
    const d = await gj(`https://api.tfl.gov.uk/StopPoint/${id}/Arrivals`);
    return { fetchedAt: new Date().toISOString(), arrivals: d.map(a => ({ line: a.lineName, lineId: a.lineId, platform: a.platformName, towards: a.towards || a.destinationName, dest: a.destinationName, secs: a.timeToStation })).sort((a, b) => a.secs - b.secs).slice(0, 14) };
  },
};
let useDirect = /github\.io$/.test(location.hostname) || location.protocol === 'file:' ? true : null; // static hosts call the APIs directly; otherwise probe for our caching proxy
async function api(name) {
  const [feed, arg] = name.split('/');
  if (useDirect === null) useDirect = fetch('api/ping', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}).then(j => !j.ok).catch(() => true);
  if (useDirect instanceof Promise) useDirect = await useDirect;
  if (useDirect) return direct[feed](arg && decodeURIComponent(arg));
  const r = await fetch('api/' + name, { cache: 'no-store' });
  const j = await r.json().catch(() => ({ error: 'bad JSON' }));
  if (!r.ok || j.error && !j.stale) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// ---------- map ----------
const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/dark',
  ...HOME, maxPitch: 80, antialias: true, attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Live data: TfL Unified API · London Air (Imperial College ERG) · Powered by TfL Open Data' }));
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

map.on('styleimagemissing', e => { if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
map.on('load', () => {
  // moody night tint
  try {
    map.setPaintProperty('background', 'background-color', '#05060c');
    map.setPaintProperty('water', 'fill-color', '#0a1530');
  } catch (e) {}
  map.addLayer({
    id: '3d-buildings', source: 'openmaptiles', 'source-layer': 'building', type: 'fill-extrusion', minzoom: 12.5,
    paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#11131f', 40, '#1d2135', 120, '#2c3355', 250, '#3f3a70'],
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.5, ['coalesce', ['get', 'render_height'], 8]],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.82,
    },
  });
  try { map.setLight({ anchor: 'map', color: '#9fb4ff', intensity: 0.35, position: [1.5, 200, 40] }); } catch (e) {}
});

const overlay = new MapboxOverlay({ interleaved: false, layers: [], getCursor: ({ isHovering }) => isHovering ? 'pointer' : 'grab' });
map.addControl(overlay);

// ---------- derived data ----------
let trips = [], linePaths = [], stations = [], lineIndex = {};
function buildLineData() {
  trips = []; linePaths = []; stations = []; lineIndex = {};
  const statusById = Object.fromEntries((S.status?.lines || []).map(l => [l.id, l]));
  const stnMap = new Map();
  for (const l of S.lines?.lines || []) {
    const st = statusById[l.id];
    const cls = st ? classify(st.statuses) : 'unknown';
    const col = hex(LINE_COLOURS[l.id] || '#ffffff');
    lineIndex[l.id] = { id: l.id, name: st?.name || l.name || l.id, cls, col, statuses: st?.statuses || [], bounds: null };
    let minX=180,minY=90,maxX=-180,maxY=-90;
    for (const p of l.paths) {
      if (p.length < 2) continue;
      linePaths.push({ id: l.id, path: p, col, cls });
      // cumulative distance -> repeated light pulses flowing along the line (visual only)
      const cum = [0];
      for (let i = 1; i < p.length; i++) cum.push(cum[i-1] + metres(p[i-1], p[i]));
      const L = cum[cum.length-1];
      const speed = cls === 'good' ? 0.75 : cls === 'minor' ? 0.35 : 0.12; // km per time unit
      const P = 6; // time period
      const copies = Math.ceil(L / 1000 / (speed * P)) + 1;
      for (let k = 0; k < copies; k++) trips.push({ id: l.id, col, cls, path: p, ts: cum.map(c => c / 1000 / speed - k * P) });
      for (const [x,y] of p) { minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y); }
    }
    if (maxX > minX) lineIndex[l.id].bounds = [[minX,minY],[maxX,maxY]];
    for (const s of l.stations) {
      const key = s.name;
      if (!stnMap.has(key)) stnMap.set(key, { id: s.id, name: s.name, pos: [s.lon, s.lat], lines: new Set() });
      stnMap.get(key).lines.add(l.id);
    }
  }
  stations = [...stnMap.values()].map(s => ({ ...s, lines: [...s.lines] }));
}

function nearestStation(pos, maxM = 900) {
  let best = null, bd = Infinity;
  for (const s of stations) { const d = metres(pos, s.pos); if (d < bd) { bd = d; best = s; } }
  return best && bd <= maxM ? { ...best, dist: bd } : null;
}
function nearestAir(pos, maxM = 3500) {
  let best = null, bd = Infinity;
  for (const s of S.air?.sites || []) { const d = metres(pos, [s.lon, s.lat]); if (d < bd) { bd = d; best = s; } }
  return best && bd <= maxM ? { ...best, dist: bd } : null;
}

// ---------- colours ----------
const CY = [46,242,255], MG = [255,61,187];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i]-v) * t));
function dockColour(d) {
  if (!d.bikes) return [70,74,92,200];
  if (S.bikeMode === 'ebike') return [...mix(CY, MG, Math.min(1, d.ebikes / Math.max(1, d.bikes))), 235];
  const f = d.docks ? d.bikes / d.docks : 0; // fullness: ember -> amber -> mint
  return [...(f < .5 ? mix([255,75,92],[255,181,71], f*2) : mix([255,181,71],[61,255,162], (f-.5)*2)), 235];
}
function airColour(i) {
  if (i <= 3) return [61,255,162]; if (i <= 6) return [255,181,71]; if (i <= 9) return [255,75,92]; return [190,80,255];
}
function airBand(i) { return i <= 3 ? 'Low' : i <= 6 ? 'Moderate' : i <= 9 ? 'High' : 'Very High'; }

// ---------- layers ----------
function layers(t) {
  const L = [];
  const sel = S.selectedLine;
  const dimFor = id => sel && sel !== id ? 0.12 : 1;
  if (S.show.air && S.air) {
    const ph = (Math.sin(t * 1.4) + 1) / 2;
    L.push(new ScatterplotLayer({
      id: 'air-halo', data: S.air.sites, getPosition: d => [d.lon, d.lat], getRadius: d => 380 + d.index * 90,
      radiusUnits: 'meters', getFillColor: d => [...airColour(d.index), 38], stroked: false, pickable: false, radiusMaxPixels: 160,
    }));
    L.push(new ScatterplotLayer({
      id: 'air-ring', data: S.air.sites, getPosition: d => [d.lon, d.lat], getRadius: d => (380 + d.index * 90) * (0.6 + ph * 0.5),
      radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 1.2, radiusMaxPixels: 200,
      getLineColor: d => [...airColour(d.index), Math.round(200 * (1 - ph) + 30)],
      updateTriggers: { getRadius: ph, getLineColor: ph },
    }));
    L.push(new ScatterplotLayer({
      id: 'air-core', data: S.air.sites, getPosition: d => [d.lon, d.lat], getRadius: 7, radiusUnits: 'pixels',
      getFillColor: d => [...airColour(d.index), 255], stroked: true, getLineColor: [0,0,0,200], lineWidthMinPixels: 1, pickable: true,
    }));
  }
  if (S.show.tube && linePaths.length) {
    const flick = (Math.sin(t * 9) > 0.2) ? 1 : 0.35;
    L.push(new PathLayer({
      id: 'line-glow', data: linePaths, getPath: d => d.path, widthUnits: 'pixels', getWidth: d => d.cls === 'severe' ? 14 : 10,
      getColor: d => d.cls === 'severe' ? [255,40,60, 70 * flick * dimFor(d.id)] : [...d.col, 55 * dimFor(d.id)],
      capRounded: true, jointRounded: true, parameters: { depthTest: false }, updateTriggers: { getColor: [flick, sel] },
    }));
    L.push(new PathLayer({
      id: 'line-core', data: linePaths, getPath: d => d.path, widthUnits: 'pixels', getWidth: 2.6, pickable: true,
      getColor: d => [...d.col, (d.cls === 'severe' ? 110 + 120 * flick : d.cls === 'minor' ? 190 : 235) * dimFor(d.id)],
      capRounded: true, jointRounded: true, parameters: { depthTest: false }, updateTriggers: { getColor: [flick, sel] },
    }));
    L.push(new TripsLayer({
      id: 'line-flow', data: trips, getPath: d => d.path, getTimestamps: d => d.ts, getColor: d => d.cls === 'severe' ? [255,90,90] : mix(d.col, [255,255,255], .55),
      opacity: sel ? 0.25 : 0.9, widthMinPixels: 3.2, trailLength: 2.2, fadeTrail: true, currentTime: (t * 1.2) % 6, capRounded: true,
      parameters: { depthTest: false },
    }));
  }
  if (S.show.stations && stations.length) {
    L.push(new ScatterplotLayer({
      id: 'stations', data: stations, getPosition: d => d.pos, getRadius: 3.6, radiusUnits: 'pixels', radiusMinPixels: 2.5,
      getFillColor: d => sel && !d.lines.includes(sel) ? [255,255,255,40] : [245,247,255,230], stroked: true, getLineColor: [5,6,12,255], lineWidthMinPixels: 1.2,
      pickable: true, parameters: { depthTest: false }, updateTriggers: { getFillColor: sel },
    }));
  }
  if (S.show.bikes && S.bikes) {
    const docks = S.bikes.docks;
    L.push(new ColumnLayer({
      id: 'bikes', data: docks, getPosition: d => [d.lon, d.lat], diskResolution: 12, radius: 24, extruded: true,
      elevationScale: Math.min(1.3, Math.max(0.1, Math.pow(2, (12.3 - map.getZoom()) * 0.8))), getElevation: d => 18 + d.bikes * 14, getFillColor: dockColour, pickable: true, autoHighlight: true, highlightColor: [255,255,255,255],
      material: { ambient: 0.55, diffuse: 0.6, shininess: 40, specularColor: [120,120,160] },
      updateTriggers: { getFillColor: S.bikeMode }, transitions: { getElevation: 1200 },
    }));
    // ripples on docks whose numbers changed between the last two live pulls
    const ch = [...S.changed.values()];
    if (ch.length) {
      const ph = (t * 0.6) % 1;
      L.push(new ScatterplotLayer({
        id: 'bike-ripples', data: ch, getPosition: d => [d.lon, d.lat], getRadius: 40 + ph * 320, radiusUnits: 'meters', radiusMinPixels: 3 + ph * 14, stroked: true, filled: false,
        lineWidthMinPixels: 1.5, getLineColor: d => d.diff > 0 ? [61,255,162, 255 * (1-ph)] : [255,181,71, 255 * (1-ph)],
        updateTriggers: { getRadius: ph, getLineColor: ph },
      }));
    }
  }
  if (S.focus) {
    const ph = (t * 0.8) % 1;
    L.push(new ScatterplotLayer({
      id: 'focus', data: [S.focus], getPosition: d => d.pos, getRadius: 40 + ph * 260, radiusUnits: 'meters', stroked: true, filled: false,
      lineWidthMinPixels: 3, getLineColor: [255,255,255, 255 * (1 - ph)], updateTriggers: { getRadius: ph, getLineColor: ph },
    }));
    L.push(new TextLayer({
      id: 'focus-label', data: [S.focus], getPosition: d => d.pos, getText: d => d.label, getSize: 15, getColor: [255,255,255],
      getPixelOffset: [0, -28], fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, outlineWidth: 4, outlineColor: [0,0,0,255],
      fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false }, billboard: true,
    }));
  }
  return L;
}

// ---------- tooltip / click ----------
function tipHTML(info) {
  const o = info.object, id = info.layer.id;
  if (id === 'bikes') return `<b>${esc(o.name)}</b><br>${o.bikes} bikes · <span style="color:#ff3dbb">${o.ebikes} e-bikes</span> · ${o.empty} empty of ${o.docks}${o.locked ? '<br><span class="sev-severe">locked</span>' : ''}`;
  if (id === 'stations') return `<b>${esc(o.name.replace(/ (Underground|DLR|Rail) Station$/,''))}</b><br><span class="muted">${o.lines.map(l => esc(lineIndex[l]?.name || l)).join(' · ')}</span><br><span class="muted">click for live arrivals</span>`;
  if (id === 'line-core') { const li = lineIndex[o.id]; return `<b>${esc(li.name)}</b><br><span class="sev-${li.cls}">${esc(li.statuses.map(s => s.desc).join(', ') || 'status unavailable')}</span>`; }
  if (id === 'air-core') return `<b>${esc(o.name)}</b><br>Air quality index <b>${o.index}</b>/10 · ${esc(o.band)}<br><span class="muted">worst pollutant: ${esc(o.worst)}</span>`;
  return null;
}
function onHover(info) {
  const tip = $('tip');
  const h = info.object ? tipHTML(info) : null;
  if (!h) { tip.classList.add('hidden'); return; }
  tip.innerHTML = h; tip.classList.remove('hidden');
  const x = Math.min(info.x + 14, window.innerWidth - 270), y = Math.min(info.y + 14, window.innerHeight - 100);
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function onClick(info) {
  if (!info.object) return;
  stopOrbit();
  const o = info.object, id = info.layer.id;
  if (id === 'bikes') showDock(o);
  else if (id === 'stations') showStation(o);
  else if (id === 'line-core') selectLine(o.id);
  else if (id === 'air-core') showAir(o);
}
overlay.setProps({ onHover, onClick });

function openCard(html) { if (window.innerWidth < 760) closeSheets(); $('cardbody').innerHTML = html; $('card').classList.remove('hidden'); }
$('cardx').onclick = () => { $('card').classList.add('hidden'); S.focus = null; };

function dockBar(o) {
  const tot = Math.max(1, o.docks || (o.bikes + o.empty));
  const w = v => (100 * v / tot).toFixed(1) + '%';
  return `<div class="bar"><i style="width:${w(o.ebikes)};background:#ff3dbb"></i><i style="width:${w(o.standard)};background:#2ef2ff"></i><i style="width:${w(o.empty)};background:#333a52"></i></div>
  <div class="muted"><span style="color:#ff3dbb">■</span> e-bikes &nbsp;<span style="color:#2ef2ff">■</span> classic &nbsp;<span style="color:#556">■</span> empty docks${o.docks - o.bikes - o.empty > 0 ? ` &nbsp;· ${o.docks - o.bikes - o.empty} dock(s) out of use` : ''}</div>`;
}
function showDock(o, why) {
  S.focus = { pos: [o.lon, o.lat], label: o.name.split(',')[0] };
  const ch = S.changed.get(o.id);
  const stn = nearestStation([o.lon, o.lat]);
  openCard(`<div class="kind">Santander Cycles dock</div><h2>${esc(o.name)}</h2>
  <div class="big"><div><b>${o.bikes}</b><span>bikes</span></div><div><b style="color:#ff3dbb">${o.ebikes}</b><span>e-bikes</span></div><div><b>${o.empty}</b><span>empty</span></div><div><b>${o.docks}</b><span>docks</span></div></div>
  ${dockBar(o)}
  ${ch ? `<p>Since the previous pull: <b class="${ch.diff > 0 ? 'sev-good' : 'sev-minor'}">${ch.diff > 0 ? '+' : ''}${ch.diff} bikes</b></p>` : ''}
  ${stn ? `<p class="muted">Nearest station: ${esc(stn.name)} · ${Math.round(stn.dist)} m</p>` : ''}
  ${why || ''}
  <p class="muted">Dock data last modified ${o.modified ? fmtTime(new Date(o.modified)) + ' (London)' : 'n/a'} · TfL BikePoint ${esc(o.id)}</p>`);
}
async function showStation(o) {
  S.focus = { pos: o.pos, label: o.name.replace(/ (Underground|DLR|Rail) Station$/, '') };
  const linesHTML = o.lines.map(l => { const li = lineIndex[l]; return `<div><span style="color:rgb(${li.col})">●</span> ${esc(li.name)} — <span class="sev-${li.cls}">${esc(li.statuses.map(s => s.desc).join(', '))}</span></div>`; }).join('');
  openCard(`<div class="kind">Station</div><h2>${esc(S.focus.label)}</h2>${linesHTML}<p class="muted">fetching live arrivals…</p>`);
  try {
    const r = await api('arrivals/' + encodeURIComponent(o.id));
    const rows = r.arrivals.map(a => `<tr><td><span style="color:rgb(${(lineIndex[a.lineId]?.col || [255,255,255])})">●</span> ${esc(a.line)}</td><td>${esc((a.towards || '').replace(/ (Underground|DLR|Rail) Station$/,''))}<div class="muted">${esc(a.platform || '')}</div></td><td>${a.secs < 60 ? 'due' : Math.floor(a.secs / 60) + ' min'}</td></tr>`).join('');
    openCard(`<div class="kind">Station · live arrivals</div><h2>${esc(S.focus.label)}</h2>${linesHTML}
      ${rows ? `<table class="arr">${rows}</table>` : '<p class="muted">TfL is reporting no predicted arrivals here right now.</p>'}
      <p class="muted">TfL predictions fetched ${fmtTimeS(new Date(r.fetchedAt))} (London)</p>`);
  } catch (e) {
    openCard(`<div class="kind">Station</div><h2>${esc(S.focus.label)}</h2>${linesHTML}<p class="sev-severe">Live arrivals feed failed: ${esc(e.message)}</p>`);
  }
}
function showAir(o) {
  S.focus = { pos: [o.lon, o.lat], label: o.name.split(' - ').pop() };
  openCard(`<div class="kind">Air quality monitor · ${esc(o.type)}</div><h2>${esc(o.name)}</h2>
  <div class="big"><div><b style="color:rgb(${airColour(o.index)})">${o.index}</b><span>index /10</span></div><div><b style="font-size:18px;line-height:31px">${esc(o.band)}</b><span>band</span></div></div>
  ${o.species.map(s => `<div>${esc(s.name)} (${esc(s.code)}): <b>${s.index}</b> · ${esc(s.band)}</div>`).join('')}
  <p class="muted">Hourly bulletin ${esc(o.bulletin)} (London) · ${esc(o.borough)} · Daily Air Quality Index, 1 = low, 10 = very high</p>`);
}
function selectLine(id) {
  S.selectedLine = S.selectedLine === id ? null : id;
  document.querySelectorAll('.ln').forEach(el => el.classList.toggle('sel', el.dataset.id === S.selectedLine));
  const li = lineIndex[id];
  if (S.selectedLine && li?.bounds) {
    map.fitBounds(li.bounds, { padding: { top: 120, bottom: 120, left: 320, right: 340 }, pitch: 50, bearing: map.getBearing() + 20, duration: 2600 });
    const reasons = li.statuses.filter(s => s.reason).map(s => `<p>${esc(s.reason)}</p>`).join('');
    openCard(`<div class="kind">Line</div><h2 style="color:rgb(${li.col})">${esc(li.name)}</h2>
      <p class="sev-${li.cls}"><b>${esc(li.statuses.map(s => s.desc).join(', '))}</b></p>${reasons}
      <p class="muted">${stations.filter(s => s.lines.includes(id)).length} stations · click a station for live arrivals · click the line again to clear</p>`);
  } else { S.focus = null; }
}

// ---------- panels ----------
function renderStatus() {
  const box = $('lines');
  if (!S.status) { box.innerHTML = `<p class="sev-severe">Tube status feed unavailable${S.errors.status ? ': ' + esc(S.errors.status) : ''}</p>`; return; }
  const order = { severe: 0, minor: 1, good: 2 };
  const ls = S.status.lines.map(l => ({ ...l, cls: classify(l.statuses) })).sort((a, b) => order[a.cls] - order[b.cls] || a.name.localeCompare(b.name));
  box.innerHTML = ls.map(l => `<div class="ln ${l.cls} ${S.selectedLine === l.id ? 'sel' : ''}" data-id="${l.id}" title="${esc(l.statuses.map(s => s.reason || s.desc).join('\n'))}">
    <i class="sw" style="background:${LINE_COLOURS[l.id] || '#fff'}"></i><span class="nm">${esc(l.name)}</span><span class="sd">${l.statuses.map(s => esc(s.desc)).join('<br>')}</span></div>`).join('');
  box.querySelectorAll('.ln').forEach(el => el.onclick = () => { stopOrbit(); selectLine(el.dataset.id); });
  const bad = ls.filter(l => l.cls !== 'good').length;
  $('st-summary').innerHTML = bad ? `<span class="sev-minor">${bad} disrupted</span> / ${ls.length}` : `<span class="sev-good">all ${ls.length} good</span>`;
}
function renderStats() {
  const d = S.bikes?.docks;
  if (!d) { ['s-bikes','s-ebikes','s-empty','s-docks','s-delta'].forEach(i => $(i).textContent = '—'); return; }
  const sum = k => d.reduce((a, x) => a + x[k], 0);
  $('s-bikes').textContent = n(sum('bikes')); $('s-ebikes').textContent = n(sum('ebikes'));
  $('s-empty').textContent = n(sum('empty')); $('s-docks').textContent = n(d.length);
  $('s-delta').textContent = S.prevBikes ? n(S.changed.size) : 'first pull';
}
function renderHealth() {
  const f = [['bikes','Bikes', () => S.bikes && `${S.bikes.docks.length} docks`], ['status','Tube status', () => S.status && `${S.status.lines.length} lines`],
    ['lines','Line map', () => S.lines && `${S.lines.lines.filter(l => l.paths.length).length} routes`], ['air','Air', () => S.air && `${S.air.sites.length} sites`]];
  $('health').innerHTML = f.map(([k, label, ok]) => {
    if (S.errors[k]) return `<span class="pill bad" title="${esc(S.errors[k])}">✕ ${label} feed down</span>`;
    const v = ok(); return v ? `<span class="pill ok">● ${label} · ${v}</span>` : `<span class="pill wait">… ${label}</span>`;
  }).join('');
  const down = Object.entries(S.errors).filter(([, v]) => v);
  const t = $('toast');
  if (down.length) { t.innerHTML = `⚠ Live feed problem — ${down.map(([k, v]) => `<b>${esc(k)}</b>: ${esc(v)}`).join(' · ')}. Showing nothing invented; affected layers are hidden or stale.`; t.classList.remove('hidden'); }
  else t.classList.add('hidden');
}
function renderLegend() {
  $('legend').innerHTML = (S.bikeMode === 'ebike'
    ? `Column height = bikes docked now<div class="grad" style="background:linear-gradient(90deg,#2ef2ff,#ff3dbb)"></div><div style="display:flex;justify-content:space-between"><span>all classic</span><span>all e-bike</span></div>`
    : `Column height = bikes docked now<div class="grad" style="background:linear-gradient(90deg,#ff4b5c,#ffb547,#3dffa2)"></div><div style="display:flex;justify-content:space-between"><span>empty</span><span>full</span></div>`)
    + `<div style="margin-top:6px">Ripples = docks that changed since last pull (<span class="sev-good">gained</span> / <span class="sev-minor">lost</span>)<br>Flowing light = good service · slow/flickering red = disruption (visual effect, not train positions)</div>`;
}

// ---------- data refresh ----------
async function refresh(initial) {
  $('refresh').classList.add('spin');
  const jobs = { bikes: api('bikes'), status: api('status'), air: api('air'), ...(S.lines ? {} : { lines: api('lines') }) };
  const res = await Promise.allSettled(Object.values(jobs));
  Object.keys(jobs).forEach((k, i) => {
    const r = res[i];
    if (r.status === 'fulfilled') {
      S.errors[k] = r.value.stale ? `stale (upstream: ${r.value.error})` : null;
      if (k === 'bikes') {
        const prev = S.bikes; const v = r.value;
        if (prev && prev.fetchedAt !== v.fetchedAt) {
          const pm = new Map(prev.docks.map(d => [d.id, d.bikes]));
          S.changed = new Map(v.docks.filter(d => pm.has(d.id) && pm.get(d.id) !== d.bikes).map(d => [d.id, { ...d, diff: d.bikes - pm.get(d.id) }]));
          S.prevBikes = prev;
        }
        S.bikes = v;
      } else S[k] = r.value;
    } else { S.errors[k] = r.reason?.message || 'failed'; if (k === 'lines') S.lines = null; }
  });
  buildLineData();
  S.lastUpdate = new Date(); S.nextAt = Date.now() + REFRESH_MS;
  $('updated').textContent = fmtTime(S.lastUpdate);
  $('refresh').classList.remove('spin');
  renderStatus(); renderStats(); renderHealth(); renderLegend();
  if (initial) { $('loading').classList.add('fade'); setTimeout(() => $('loading').remove(), 1100); }
}
$('refresh').onclick = () => refresh();
setInterval(() => {
  $('clock').textContent = fmtTimeS(new Date());
  const left = Math.max(0, S.nextAt - Date.now());
  $('ring').style.strokeDashoffset = (94.25 * (1 - left / REFRESH_MS)).toFixed(1);
  if (S.nextAt && left === 0 && !document.hidden) { S.nextAt = Date.now() + REFRESH_MS; refresh(); }
}, 1000);

// ---------- controls ----------
const toggles = { bikes: 'L-bikes', tube: 'L-tube', stations: 'L-stations', air: 'L-air' };
Object.entries(toggles).forEach(([k, id]) => $(id).onchange = e => { S.show[k] = e.target.checked; });
$('L-buildings').onchange = e => { if (map.getLayer('3d-buildings')) map.setLayoutProperty('3d-buildings', 'visibility', e.target.checked ? 'visible' : 'none'); };
document.querySelectorAll('#bikeMode button').forEach(b => b.onclick = () => {
  S.bikeMode = b.dataset.m; document.querySelectorAll('#bikeMode button').forEach(x => x.classList.toggle('on', x === b)); renderLegend();
});
$('home').onclick = () => { stopOrbit(); S.selectedLine = null; S.focus = null; renderStatus(); $('card').classList.add('hidden'); map.flyTo({ ...HOME, duration: 3000 }); };

function startOrbit() { S.orbit = true; $('orbit').classList.add('on'); }
function stopOrbit() { S.orbit = false; $('orbit').classList.remove('on'); }
$('orbit').onclick = () => S.orbit ? stopOrbit() : (startOrbit(), map.easeTo({ pitch: 62, duration: 1500 }));
map.on('mousedown', stopOrbit); map.on('touchstart', stopOrbit); map.on('wheel', stopOrbit);

const sheet = (btn, id, other) => $(btn).onclick = () => { $(other).classList.remove('open'); $('card').classList.add('hidden'); $(id).classList.toggle('open'); };
sheet('mLayers', 'layers', 'status'); sheet('mLines', 'status', 'layers');
function closeSheets() { $('layers').classList.remove('open'); $('status').classList.remove('open'); }

// ---------- "Where should I go right now?" ----------
const MISSIONS = [
  'Ride somewhere you have never been and buy the first snack you see.',
  'Follow the river until a bridge looks interesting, then cross it.',
  'Find the oldest-looking pub door within ten minutes of here.',
  'Take only left turns for fifteen minutes. See where London puts you.',
  'Find a blue plaque and look up who it is for.',
  'Cycle to the nearest park and lie on the grass for five minutes.',
  'Look up. Count the cranes on the skyline before you set off.',
  'Pick a church spire on the horizon and try to reach it.',
];
function suggest() {
  stopOrbit();
  if (!S.bikes) { openCard('<p class="sev-severe">The bike feed is down, so I can\'t pick a real spot right now.</p>'); return; }
  const scored = [];
  for (const d of S.bikes.docks) {
    if (d.locked || !d.installed || d.bikes < 2) continue;
    const pos = [d.lon, d.lat];
    const stn = nearestStation(pos, 800);
    const air = nearestAir(pos);
    const goodLines = stn ? stn.lines.filter(l => lineIndex[l]?.cls === 'good') : [];
    let score = d.ebikes * 3 + d.standard * 0.6 + goodLines.length * 3;
    if (stn && goodLines.length === 0) score -= 6;
    if (air) score -= Math.max(0, air.index - 3) * 2;
    scored.push({ d, stn, air, goodLines, score });
  }
  if (!scored.length) { openCard('<p>No unlocked dock currently has 2+ bikes. London is fully cycled out.</p>'); return; }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 18);
  const pick = top[Math.floor(Math.random() * top.length)];
  const { d, stn, air, goodLines } = pick;
  const rank = scored.indexOf(pick) + 1;
  const why = [
    `<li><b style="color:#ff3dbb">${d.ebikes} e-bike${d.ebikes === 1 ? '' : 's'}</b> and ${d.standard} classic bike${d.standard === 1 ? '' : 's'} docked here right now</li>`,
    stn ? `<li>${esc(stn.name.replace(/ (Underground|DLR|Rail) Station$/, ''))} is ${Math.round(stn.dist)} m away${goodLines.length ? ` — <span class="sev-good">${goodLines.map(l => esc(lineIndex[l].name)).join(', ')}: good service</span>${stn.lines.filter(l => !goodLines.includes(l)).map(l => ` · <span class="sev-${lineIndex[l].cls}">${esc(lineIndex[l].name)}: ${esc(lineIndex[l].statuses.map(s => s.desc).join(', '))}</span>`).join('')}` : ' — <span class="sev-minor">its lines are disrupted, so bike it</span>'}</li>` : '<li>No station within 800 m: proper two-wheel territory</li>',
    air ? `<li>Nearest air monitor (${esc(air.name)}, ${(air.dist / 1000).toFixed(1)} km): index <b style="color:rgb(${airColour(air.index)})">${air.index}/10 · ${esc(air.band)}</b></li>` : '',
    `<li>Ranked #${rank} of ${scored.length} docks on e-bikes, transit health and air right now (picked at random from the top ${top.length})</li>`,
  ].join('');
  const mission = MISSIONS[Math.floor(Math.random() * MISSIONS.length)];
  map.flyTo({ center: [d.lon, d.lat], zoom: 16.4, pitch: 66, bearing: map.getBearing() + 120 + Math.random() * 120, duration: 5200, curve: 1.8, essential: true });
  showDock(d, `<div class="kind" style="margin-top:8px">Why here, why now</div><ul class="why">${why}</ul><div class="mission">✦ ${mission}</div>`);
  $('cardbody').querySelector('.kind').textContent = '✦ Go here right now';
  map.once('moveend', () => { if (!S.orbit) { startOrbit(); } });
}
$('go').onclick = suggest;

// ---------- animation loop ----------
const t0 = performance.now();
let lastOrbit = performance.now();
function frame(now) {
  const t = (now - t0) / 1000;
  if (S.orbit && !map.isMoving()) map.setBearing(map.getBearing() + (now - lastOrbit) * 0.004);
  lastOrbit = now;
  overlay.setProps({ layers: layers(t) });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
refresh(true);
window.__LL = S; // for debugging/tests
S.debug = { map, api, showStation, stations: () => stations };
})();
