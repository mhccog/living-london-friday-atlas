/* London, Inc. — Business mode for Living London.
   Real data only. Every layer reads a JSON file in data/business/ that scripts/build_business.py (run daily by GitHub Actions)
   built from open public sources, or the live TfL feeds already used by Living mode. If a file is missing, stale, or a
   source needs a key we don't have yet, the page says so instead of inventing numbers. */
(() => {
const { ColumnLayer, PathLayer, ScatterplotLayer, TripsLayer, TextLayer, PolygonLayer } = deck;
let LL, S, map, $, esc, n;
const GOLD = [245, 196, 81], EM = [47, 227, 160], ROSE = [255, 77, 94], SKY = [90, 169, 255], VIO = [167, 139, 250];
const TZ = 'Europe/London';
const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));
const money = v => v == null ? '–' : v >= 1e9 ? `£${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}bn` : v >= 1e6 ? `£${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}m` : v >= 1e3 ? `£${Math.round(v / 1e3)}k` : `£${Math.round(v)}`;
const moneyFull = v => v == null ? '–' : '£' + Math.round(v).toLocaleString('en-GB');
const titleCase = s => String(s || '').toLowerCase().replace(/(^|[\s(\-\/&.'])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Ltd|Llp|Plc|Uk|Cic|Lp|Nhs)\b/g, x => x.toUpperCase());
const dayMs = 86400e3;
const parseD = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const fmtD = (ms, o) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...(o || { weekday: 'short', day: 'numeric', month: 'short' }) }).format(ms);
const SD = { day: 'numeric', month: 'short' };
const diffDays = (a, b) => Math.round((parseD(a) - parseD(b)) / dayMs);
const when = iso => iso ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '–';
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const R = (a, b) => Math.sqrt(((a[0] - b[0]) * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180)) ** 2 + (a[1] - b[1]) ** 2) * 111320;
const LONDON_CENTRE = [-0.09, 51.51];
const DKEY = { MON: 'mon', TUE: 'midweek', WED: 'midweek', THU: 'midweek', FRI: 'fri', SAT: 'sat', SUN: 'sun' };

const B = {
  inited: false, active: false, tab: 'churn', D: {}, st: {}, manifest: null,
  show: { churn: true, offshore: false, jobs: false, contracts: false, commute: true, sales: false },
  day: null, playing: false, playTimer: null, focus: null, lastDaySwitch: 0, cm: 'now',
};
const LAYERS = [
  { k: 'churn', name: 'Company births & deaths', col: '#2fe3a0', files: ['births', 'deaths'], tag: 'snapshot + daily' },
  { k: 'commute', name: 'The commute, measured', col: '#f5c451', files: [], tag: 'TfL live' },
  { k: 'contracts', name: 'Government money', col: '#ffd778', files: ['contracts'], tag: 'last 30 days' },
  { k: 'sales', name: 'Property sales towers', col: '#5aa9ff', files: ['sales'], tag: 'Land Registry' },
  { k: 'jobs', name: "Who's hiring where", col: '#a78bfa', files: ['jobs'], tag: 'ONS jobs' },
  { k: 'offshore', name: 'Offshore London', col: '#ff4d5e', files: ['offshore'], tag: 'overseas owners' },
];
const TABS = [['churn', 'Churn'], ['commute', 'Commute'], ['contracts', 'Contracts'], ['sales', 'Sales'], ['jobs', 'Jobs'], ['offshore', 'Offshore']];

// ---------- office districts for the commute meter (station ids are from data/london.json) ----------
const DISTRICTS = [
  { id: 'bank', name: 'Bank & Monument', st: ['HUBBAN', '940GZZLUMMT'], blurb: 'the City core' },
  { id: 'cw', name: 'Canary Wharf', st: ['HUBCAW'], blurb: 'the second financial centre' },
  { id: 'lst', name: 'Liverpool Street', st: ['HUBLST'], blurb: 'City north / Broadgate' },
  { id: 'mgt', name: 'Moorgate', st: ['HUBZMG'], blurb: 'City & Barbican' },
  { id: 'fcn', name: 'Farringdon', st: ['HUBZFD'], blurb: 'Elizabeth line, media & tech' },
  { id: 'kgx', name: "King's Cross & St Pancras", st: ['HUBKGX'], blurb: 'the Knowledge Quarter' },
  { id: 'vic', name: 'Victoria', st: ['HUBVIC'], blurb: 'Westminster commuter gate' },
  { id: 'wat', name: 'Waterloo', st: ['HUBWAT'], blurb: 'South Bank commuters' },
  { id: 'lbg', name: 'London Bridge', st: ['HUBLBG'], blurb: 'The Shard & Borough' },
  { id: 'cst', name: 'Cannon Street & Blackfriars', st: ['HUBCST', 'HUBBFR'], blurb: 'the riverside City' },
  { id: 'hol', name: 'Holborn & Chancery Lane', st: ['940GZZLUHBN', '940GZZLUCHL'], blurb: 'law & Midtown' },
  { id: 'old', name: 'Old Street', st: ['HUBOLD'], blurb: 'Silicon Roundabout' },
  { id: 'pad', name: 'Paddington', st: ['HUBPAD'], blurb: 'Paddington Basin' },
  { id: 'eus', name: 'Euston', st: ['HUBEUS'], blurb: 'Fitzrovia & the north' },
  { id: 'west', name: 'West End: Bond St, Oxford Circus, Tottenham Ct Rd', st: ['HUBBDS', '940GZZLUOXC', 'HUBTCR'], blurb: 'retail, media & ad-land' },
  { id: 'wsm', name: 'Westminster, Charing Cross & Embankment', st: ['HUBWSM', 'HUBCHX', '940GZZLUEMB'], blurb: 'Whitehall & the Strand' },
  { id: 'tow', name: 'Tower Hill & Aldgate', st: ['940GZZLUTWH', '940GZZLUALD', '940GZZLUADE'], blurb: 'the eastern City fringe' },
  { id: 'str', name: 'Stratford', st: ['HUBSRA'], blurb: 'East Bank & Westfield' },
];
let districts = [];
function buildDistricts() {
  districts = DISTRICTS.map(d => {
    const sts = d.st.map(id => S.stById.get(id)).filter(Boolean);
    if (!sts.length) return null;
    const pos = [sts.reduce((a, s) => a + s.pos[0], 0) / sts.length, sts.reduce((a, s) => a + s.pos[1], 0) / sts.length];
    const mid = sts.reduce((a, s) => a + (s.daily?.midweek || 0), 0), sun = sts.reduce((a, s) => a + (s.daily?.sun || 0), 0);
    return { ...d, sts, pos, mid, sun, office: sun > 0 ? mid / sun : null };
  }).filter(Boolean);
}
// district meter: live ratio (live reading / typical for the same slot) where TfL gives one; otherwise typical profile now vs the day's peak
function meter(d) {
  let typ = 0, live = 0, liveTyp = 0, nl = 0, flowNow = 0, peakFlow = 0, liveAt = null;
  for (const s of d.sts) {
    const b = LL.busy(s);
    if (b.typFlow != null) {
      typ += b.typFlow; flowNow += b.flow ?? b.typFlow;
      if (b.kind === 'live' && b.live.typ >= 0.03) { live += b.flow; liveTyp += b.typFlow; nl++; liveAt = b.live.timeLocal; }
    }
    const pk = LL.busiestSlot(s, S.day), dly = s.daily?.[DKEY[S.day]];
    if (pk && dly && s.sums?.[S.day]) peakFlow += dly * pk.pct / s.sums[S.day];
  }
  const ratio = nl && liveTyp > 0 ? live / liveTyp : null;
  return { typ, flowNow, peakFlow, ofPeak: peakFlow ? typ / peakFlow : null, ratio, nl, liveAt };
}
function profileFor(d, day) {
  const arr = new Array(96).fill(0), key = DKEY[day];
  for (const s of d.sts) if (s.prof?.[day] && s.daily?.[key]) { const sum = s.sums[day] || 1; for (let i = 0; i < 96; i++) arr[i] += s.daily[key] * s.prof[day][i] / sum; }
  return arr;
}

// ---------- data ----------
async function jget(path, bust) {
  const r = await fetch(path + (bust ? (path.includes('?') ? '&' : '?') + 'g=' + encodeURIComponent(bust) : ''), { cache: 'no-cache' });
  if (!r.ok) throw new Error(path.split('?')[0] + ' HTTP ' + r.status);
  return r.json();
}
async function loadData() {
  let man = null;
  try { man = await jget('data/business/manifest.json?t=' + Date.now()); B.manifest = man; } catch (e) {}
  const names = ['births', 'births_fresh', 'deaths', 'offshore', 'jobs', 'contracts', 'sales'];
  await Promise.all(names.map(async nm => {
    try { B.D[nm] = await jget(`data/business/${nm}.json`, man?.files?.[nm + '.json']?.generated); B.st[nm] = B.D[nm].status || 'ok'; }
    catch (e) { B.D[nm] = null; B.st[nm] = 'missing'; B.st[nm + '_err'] = e.message; }
  }));
  try { B.boroughs = await jget('data/business/boroughs.json'); } catch (e) { B.boroughs = null; }
  prepAll();
}
let P = [], N = 30, deaths = [], contracts = [], sales = [], boroughRows = [], offshoreRows = [], offshorePaths = [], cumCache = new Map();
function prepAll() {
  const b = B.D.births;
  if (b?.rows && b.status !== 'down') {
    N = diffDays(b.end, b.start) + 1;
    P = b.postcodes.map((p, i) => ({ i, pc: p[0], pos: [p[1], p[2]], borough: p[3], cnt: new Uint16Array(N), total: 0, rows: [] }));
    for (const r of b.rows) { const p = P[r[0]]; if (r[1] >= 0 && r[1] < N) { p.cnt[r[1]]++; p.total++; p.rows.push(r); } }
    for (const p of P) { p.cum = new Uint16Array(N); let c = 0; for (let i = 0; i < N; i++) { c += p.cnt[i]; p.cum[i] = c; } }
    P = P.filter(p => p.total > 0).sort((a, b2) => b2.total - a.total);
    B.births = { total: P.reduce((a, p) => a + p.total, 0), perDay: Array.from({ length: N }, (_, d) => P.reduce((a, p) => a + p.cnt[d], 0)) };
  } else { P = []; B.births = null; }
  cumCache.clear();
  const d = B.D.deaths;
  if (d?.rows && b?.start && d.status !== 'down') {
    const off = diffDays(d.start, b.start);
    deaths = d.rows.map(r => ({ pos: [r[0], r[1]], day: r[2] + off, name: r[3], kind: r[4], number: r[5], addr: r[6], url: r[7], cat: r[8], date: new Date(parseD(b.start) + (r[2] + off) * dayMs) }));
    B.deathsIn = deaths.filter(x => x.day >= 0 && x.day < N).length; B.deathsAfter = deaths.filter(x => x.day >= N).length;
    B.deathsPerDay = Array.from({ length: N }, (_, i) => deaths.filter(x => x.day === i).length);
  } else { deaths = []; B.deathsIn = 0; B.deathsAfter = 0; B.deathsPerDay = []; }
  const c = B.D.contracts;
  if (c?.rows && c.status !== 'down') {
    const rows = c.rows.map(r => ({ pos: [r[0], r[1]], supplier: r[2], value: r[3], date: r[4], buyer: r[5], title: r[6], url: r[7], src: r[8], pc: r[9], via: r[10], desc: r[11] }));
    const grp = new Map(), key = r => [r.buyer, r.title, r.value].join('|');
    rows.forEach(r => grp.set(key(r), (grp.get(key(r)) || 0) + 1));
    rows.forEach(r => { r.shared = grp.get(key(r)); r.eff = r.value ? r.value / r.shared : null; });
    const by = new Map();
    rows.forEach(r => { let g = by.get(r.pc); if (!g) by.set(r.pc, g = { pc: r.pc, pos: r.pos, awards: [], eff: 0 }); g.awards.push(r); g.eff += r.eff || 0; });
    contracts = [...by.values()]; contracts.forEach(g => g.awards.sort((a, b2) => (b2.eff || 0) - (a.eff || 0)));
    B.awards = rows;
  } else { contracts = []; B.awards = []; }
  const s = B.D.sales;
  if (s?.rows && s.status !== 'down') { sales = s.rows.map(r => ({ pos: [r[0], r[1]], price: r[2], date: r[3], type: r[4], nb: r[5], tenure: r[6], addr: r[7], pc: r[8], borough: r[9], cat: r[10] })); B.salesMedian = median(sales.map(x => x.price)); } else { sales = []; B.salesMedian = null; }
  const j = B.D.jobs;
  if (j?.boroughs && B.boroughs && j.status !== 'down') {
    const m = new Map(j.boroughs.map(x => [x.code, x]));
    boroughRows = B.boroughs.features.map(f => {
      const x = m.get(f.properties.LAD24CD) || {}, ring = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0]);
      return { code: f.properties.LAD24CD, name: f.properties.LAD24NM, ring, jobs: x.jobs, year: x.jobs_year, density: x.density, claimants: x.claimants, rate: x.claim_rate,
        centre: [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length], adz: j.adzuna?.status === 'ok' ? j.adzuna.by_borough?.[f.properties.LAD24CD] : null };
    });
    B.jobsMax = Math.max(...boroughRows.map(r => r.jobs || 0)); B.rateMax = Math.max(...boroughRows.map(r => r.rate || 0));
  } else boroughRows = [];
  const o = B.D.offshore;
  offshoreRows = o?.rows && o.status !== 'down' ? o.rows.map(r => ({ ...r, pos: [r.lon, r.lat] })) : [];
  B.offMax = Math.max(1, ...offshoreRows.map(r => r.n));
  offshorePaths = offshoreRows.map(r => arcPath(r.pos, LONDON_CENTRE, r));
}
function arcPath(a, b, r) {
  const K = 40, d = R(a, b), H = Math.min(2.2e6, d * 0.22), pts = [], ts = [];
  for (let k = 0; k <= K; k++) { const f = k / K; pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, Math.sin(Math.PI * f) * H]); ts.push(k / K); }
  return { r, path: pts, ts };
}

// ---------- churn timeline ----------
function curDay() { return B.day == null ? N : B.day; } // N = "all"
function births(d) {
  let v = cumCache.get(d);
  if (!v) { v = P.map(p => ({ p, c: d >= N ? p.total : p.cum[d] })).filter(x => x.c > 0); cumCache.set(d, v); }
  return v;
}
function setDay(d, user) { B.day = d == null || d >= N ? null : d; B.lastDaySwitch = performance.now(); if (user) stopPlay(); renderScrub(); }
function startPlay() {
  B.playing = true; if (B.day == null || B.day >= N - 1) B.day = 0; B.lastDaySwitch = performance.now(); renderScrub();
  clearInterval(B.playTimer);
  B.playTimer = setInterval(() => { B.day = (B.day == null ? 0 : B.day) + 1; if (B.day >= N) { B.day = null; stopPlay(); } B.lastDaySwitch = performance.now(); renderScrub(); }, 900);
}
function stopPlay() { B.playing = false; clearInterval(B.playTimer); renderScrub(); }
function renderScrub() {
  const el = $('bz-scrub'); if (!el) return;
  const on = B.show.churn && !!B.births;
  el.classList.toggle('hidden', !on);
  if (!on) return;
  const b = B.D.births, d = curDay();
  if (!el.dataset.built) {
    el.dataset.built = 1;
    el.innerHTML = `<button class="ic" id="bz-play" title="Play the month day by day (space)">▶</button><input id="bz-slider" type="range" min="0" max="${N}" step="1"><div class="sl" id="bz-sl"></div><button class="ic txt" id="bz-all" title="Show the whole month">All</button>`;
    $('bz-play').onclick = () => B.playing ? stopPlay() : startPlay();
    $('bz-slider').oninput = e => setDay(+e.target.value, true);
    $('bz-all').onclick = () => { stopPlay(); setDay(null); };
  }
  $('bz-play').textContent = B.playing ? '❚❚' : '▶'; $('bz-play').classList.toggle('on', B.playing);
  $('bz-slider').max = N; $('bz-slider').value = d;
  if (d >= N) $('bz-sl').innerHTML = `<b>${fmtD(parseD(b.start), SD)} – ${fmtD(parseD(b.end), SD)}</b><span><span class="g">+${n(B.births.total)} born</span> · <span class="r">${n(B.deathsIn)} wound up</span></span>`;
  else $('bz-sl').innerHTML = `<b>${fmtD(parseD(b.start) + d * dayMs)}</b><span><span class="g">+${n(B.births.perDay[d])}</span> · <span class="r">${n(B.deathsPerDay[d] || 0)}</span> that day</span>`;
}

// ---------- layers ----------
function layers(t, zoom) {
  const L = [];
  const es = Math.min(1.2, Math.max(0.08, Math.pow(2, (12 - zoom) * 0.8)));
  if (B.show.jobs && boroughRows.length) {
    const jes = Math.min(1, es * 1.1);
    L.push(new PolygonLayer({ id: 'bz-jobs', data: boroughRows, getPolygon: d => d.ring, extruded: true, wireframe: false, getElevation: d => (d.jobs || 0) / 330,
      getFillColor: d => { const r = d.rate == null ? 0 : d.rate / Math.max(1, B.rateMax); return [...mixc(mixc([60, 215, 170], [255, 196, 90], r * 1.6), ROSE, Math.max(0, r - 0.55) * 2.2), 175]; },
      getLineColor: [255, 255, 255, 90], lineWidthMinPixels: 1, stroked: true, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 70], material: { ambient: 0.55, diffuse: 0.7, shininess: 30 }, elevationScale: jes }));
    L.push(new TextLayer({ id: 'bz-jobs-lbl', data: boroughRows.filter(d => (d.jobs || 0) > 250000), getPosition: d => [...d.centre, (d.jobs || 0) / 330 * jes + 60], getText: d => `${d.name}\n${(d.jobs / 1000).toFixed(0)}k jobs`, getSize: 12, getColor: [255, 255, 255, 230], outlineWidth: 3, outlineColor: [0, 0, 0, 230], fontFamily: 'Space Grotesk, sans-serif', fontWeight: 600, fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false }, updateTriggers: { getPosition: jes } }));
  }
  if (B.show.churn && B.births) {
    const d = curDay(), live = d < N, bd = births(d), since = (performance.now() - B.lastDaySwitch) / 1000;
    L.push(new ScatterplotLayer({ id: 'bz-births', data: bd, getPosition: x => x.p.pos, radiusUnits: 'meters', getRadius: x => 22 + Math.sqrt(x.c) * 7, radiusMinPixels: 2.2, radiusMaxPixels: 60,
      getFillColor: x => [...EM, Math.min(215, 90 + x.c * 3)], pickable: true, parameters: { depthTest: false }, updateTriggers: { getRadius: d, getFillColor: d } }));
    L.push(new ScatterplotLayer({ id: 'bz-births-core', data: bd, getPosition: x => x.p.pos, radiusUnits: 'pixels', getRadius: x => x.c > 4 ? 2.6 : 1.8, getFillColor: x => [235, 255, 245, x.c > 4 ? 245 : 150], parameters: { depthTest: false } }));
    if (live) {
      const fresh = P.filter(p => p.cnt[d] > 0);
      L.push(new ScatterplotLayer({ id: 'bz-birth-burst', data: fresh, getPosition: p => p.pos, radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 2, parameters: { depthTest: false },
        getRadius: p => 60 + ((t * 0.7 + (p.i % 7) / 7) % 1) * (260 + Math.sqrt(p.cnt[d]) * 30), getLineColor: p => [...EM, 255 * (1 - (t * 0.7 + (p.i % 7) / 7) % 1)], updateTriggers: { getRadius: t, getLineColor: t } }));
    } else {
      L.push(new ScatterplotLayer({ id: 'bz-birth-hum', data: P.slice(0, 40), getPosition: p => p.pos, radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 1.4, parameters: { depthTest: false },
        getRadius: p => 50 + ((t * 0.18 + (p.i % 9) / 9) % 1) * (120 + Math.sqrt(p.total) * 10), getLineColor: p => [...EM, 170 * (1 - (t * 0.18 + (p.i % 9) / 9) % 1)], updateTriggers: { getRadius: t, getLineColor: t } }));
    }
    const dd = deaths.filter(x => d >= N ? true : x.day <= d && x.day >= -3), fresh0 = since < 1.2;
    L.push(new ScatterplotLayer({ id: 'bz-deaths', data: dd, getPosition: x => x.pos, radiusUnits: 'pixels', pickable: true, parameters: { depthTest: false },
      getRadius: x => { const age = d >= N ? 9 : d - x.day; return (x.kind === 'petition' ? 4 : 5.2) + (age === 0 && fresh0 ? (1 - since / 1.2) * 7 : 0); },
      getFillColor: x => { const age = d >= N ? (x.day >= N ? 0 : 5) : d - x.day, a = Math.max(45, 235 - age * 20); return x.kind === 'petition' ? [255, 150, 90, a * 0.8] : [...ROSE, a]; },
      stroked: true, getLineColor: x => [255, 205, 210, x.kind === 'petition' ? 80 : 150], lineWidthMinPixels: 1, updateTriggers: { getRadius: [d, fresh0, Math.floor(since * 6)], getFillColor: d } }));
    if (live) L.push(new ScatterplotLayer({ id: 'bz-death-burst', data: dd.filter(x => x.day === d), getPosition: x => x.pos, radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 2, parameters: { depthTest: false },
      getRadius: x => 40 + ((t * 0.9) % 1) * 260, getLineColor: x => [...ROSE, 255 * (1 - (t * 0.9) % 1)], updateTriggers: { getRadius: t, getLineColor: t } }));
    L.push(new TextLayer({ id: 'bz-births-lbl', data: P.slice(0, 3).filter(p => d >= N || p.cum[d] > 40), getPosition: p => p.pos, getText: p => `${n(d >= N ? p.total : p.cum[d])} firms · ${p.pc}`, getSize: 12, getPixelOffset: [0, -16],
      getColor: [200, 255, 230, 245], outlineWidth: 3, outlineColor: [0, 10, 5, 240], fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false }, updateTriggers: { getText: d } }));
  }
  if (B.show.contracts && contracts.length) {
    L.push(new ColumnLayer({ id: 'bz-contracts', data: contracts, getPosition: g => g.pos, diskResolution: 6, radius: 60, extruded: true, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 255], elevationScale: es,
      getElevation: g => g.eff > 0 ? Math.max(25, (Math.log10(g.eff) - 3.4) * 200) : 25, getFillColor: g => g.eff > 0 ? [...mixc([200, 150, 40], [255, 243, 200], (Math.log10(g.eff) - 4) / 3.5), 235] : [120, 120, 130, 150],
      material: { ambient: 0.6, diffuse: 0.6, shininess: 60, specularColor: [255, 220, 150] } }));
    L.push(new ScatterplotLayer({ id: 'bz-contracts-ring', data: contracts.filter(g => g.eff > 5e6), getPosition: g => g.pos, radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 1.5, parameters: { depthTest: false },
      getRadius: g => 90 + ((t * 0.3 + (g.pc.charCodeAt(2) % 5) / 5) % 1) * 280, getLineColor: g => [...GOLD, 200 * (1 - (t * 0.3 + (g.pc.charCodeAt(2) % 5) / 5) % 1)], updateTriggers: { getRadius: t, getLineColor: t } }));
  }
  if (B.show.sales && sales.length) {
    L.push(new ColumnLayer({ id: 'bz-sales', data: sales, getPosition: x => x.pos, diskResolution: 8, radius: 30, radiusUnits: 'meters', extruded: true, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 255], elevationScale: es,
      getElevation: x => 105 * Math.log(x.price / 50000 + 1), getFillColor: x => [...(x.price < 4e5 ? mixc([55, 100, 200], SKY, x.price / 4e5) : x.price < 1.2e6 ? mixc(SKY, GOLD, (x.price - 4e5) / 8e5) : mixc(GOLD, [255, 245, 215], (x.price - 1.2e6) / 3e6)), 230],
      material: { ambient: 0.6, diffuse: 0.6, shininess: 40 } }));
  }
  if (B.show.commute && districts.length) {
    const data = districts.map(d => ({ d, m: meter(d) })), cols = data.flatMap(x => x.d.sts.map(s => ({ ...x, s })));
    L.push(new ColumnLayer({ id: 'bz-commute', data: cols, getPosition: x => x.s.pos, diskResolution: 14, radius: 95, extruded: true, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 255], elevationScale: es,
      getElevation: x => 30 + (LL.busy(x.s).flow ?? 0) * 0.16 * (1 + 0.06 * Math.sin(t * 1.4 + x.s.phase)), getFillColor: x => [...commuteColour(x.m, LL.busy(x.s)), 225],
      material: { ambient: 0.6, diffuse: 0.6, shininess: 50, specularColor: [255, 225, 160] }, updateTriggers: { getElevation: [t, S.crowd.size], getFillColor: [S.crowd.size, S.slot] } }));
    const ph = x => (t * (0.2 + Math.min(1, (x.m.flowNow || 0) / 6000)) + x.d.pos[0] * 50) % 1;
    L.push(new ScatterplotLayer({ id: 'bz-commute-ring', data, getPosition: x => x.d.pos, radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 1.5, parameters: { depthTest: false },
      getRadius: x => 120 + ph(x) * 320, getLineColor: x => [...commuteColour(x.m), 190 * (1 - ph(x))], updateTriggers: { getRadius: t, getLineColor: t } }));
    L.push(new ScatterplotLayer({ id: 'bz-commute-live', data: data.filter(x => x.m.nl), getPosition: x => x.d.pos, radiusUnits: 'pixels', getRadius: 3.2, getFillColor: [255, 255, 255, 255], stroked: true, getLineColor: [255, 77, 94, 255], lineWidthMinPixels: 1.5, parameters: { depthTest: false } }));
    if (zoom > 12.2) L.push(new TextLayer({ id: 'bz-commute-lbl', data, getPosition: x => x.d.pos, getText: x => x.d.name.split(':')[0], getSize: 11, getPixelOffset: [0, 16], getColor: [255, 236, 190, 235], outlineWidth: 3, outlineColor: [8, 6, 0, 240], fontFamily: 'Space Grotesk, sans-serif', fontWeight: 600, fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false } }));
  }
  if (B.show.offshore && offshoreRows.length) {
    L.push(new PathLayer({ id: 'bz-off-arcs', data: offshorePaths, getPath: d => d.path, widthUnits: 'pixels', getWidth: d => 1 + Math.log10(d.r.n + 1) * 1.7, getColor: d => [...mixc(GOLD, ROSE, Math.log10(d.r.n) / 4), 120], capRounded: true, jointRounded: true, pickable: true, parameters: { depthTest: false } }));
    L.push(new TripsLayer({ id: 'bz-off-flow', data: offshorePaths, getPath: d => d.path, getTimestamps: d => d.ts, getColor: d => mixc([255, 235, 170], [255, 140, 150], Math.log10(d.r.n) / 4), widthMinPixels: 3, trailLength: 0.35, fadeTrail: true, currentTime: (t * 0.16) % 1.6, capRounded: true, parameters: { depthTest: false } }));
    L.push(new ScatterplotLayer({ id: 'bz-off-dots', data: offshoreRows, getPosition: d => d.pos, radiusUnits: 'pixels', getRadius: d => 3 + Math.sqrt(d.n) * 0.28, getFillColor: d => [...mixc(GOLD, ROSE, Math.log10(d.n) / 4), 230], stroked: true, getLineColor: [255, 255, 255, 200], lineWidthMinPixels: 1, pickable: true, parameters: { depthTest: false } }));
    L.push(new TextLayer({ id: 'bz-off-lbl', data: offshoreRows.slice(0, 16), getPosition: d => d.pos, getText: d => `${d.country.replace(', British', '')} ${n(d.n)}`, getSize: 12, getPixelOffset: [0, -16], getColor: [255, 232, 205, 245], outlineWidth: 3, outlineColor: [20, 4, 6, 240], fontFamily: 'Space Grotesk, sans-serif', fontWeight: 600, fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false } }));
  }
  if (B.focus) {
    const ph = (t * 0.8) % 1;
    L.push(new ScatterplotLayer({ id: 'bz-focus', data: [B.focus], getPosition: d => d.pos, getRadius: 60 + ph * 320, radiusUnits: 'meters', stroked: true, filled: false, lineWidthMinPixels: 3, getLineColor: [255, 255, 255, 255 * (1 - ph)], updateTriggers: { getRadius: ph, getLineColor: ph } }));
    L.push(new TextLayer({ id: 'bz-focus-lbl', data: [B.focus], getPosition: d => d.pos, getText: d => d.label, getSize: 15, getColor: [255, 255, 255], getPixelOffset: [0, -30], fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, outlineWidth: 4, outlineColor: [0, 0, 0, 255], fontSettings: { sdf: true }, characterSet: 'auto', parameters: { depthTest: false } }));
  }
  return L;
}
function commuteColour(m, b) {
  if (m.ratio != null && (!b || (b.kind === 'live' && b.live.typ >= 0.03))) { const r = b?.kind === 'live' ? b.live.ratio : m.ratio; return r < 1 ? mixc(SKY, GOLD, (r - 0.4) / 0.6) : mixc(GOLD, ROSE, (r - 1) / 0.5); }
  return mixc([110, 80, 25], GOLD, (m.ofPeak ?? 0.4) * 1.2);
}

// ---------- tooltips + cards ----------
const kindLabel = { order: 'Winding-up order (court)', admin: 'Administrators appointed', resolution: 'Resolution to wind up', petition: 'Petition to wind up (not yet ordered)' };
const typeName = { D: 'detached', S: 'semi-detached', T: 'terraced', F: 'flat', O: 'other' };
function tip(info) {
  const o = info.object, id = info.layer.id;
  if (id === 'bz-births') {
    const p = o.p, names = p.rows.filter(r => curDay() >= N || r[1] <= curDay()).slice(-3).map(r => esc(titleCase(r[2])));
    return `<b class="g">${n(o.c)} new compan${o.c === 1 ? 'y' : 'ies'}</b> at <b>${esc(p.pc)}</b><br><span class="muted">${esc(p.borough || '')} · registered office</span><br>${names.join('<br>')}${o.c > 3 ? `<br><span class="muted">…and ${n(o.c - 3)} more · click for the list</span>` : '<br><span class="muted">click for details</span>'}`;
  }
  if (id === 'bz-deaths') return `<b class="r">${esc(titleCase(o.name))}</b><br>${esc(kindLabel[o.kind] || o.cat)}<br><span class="muted">Gazette notice ${fmtD(o.date.getTime())}${o.number ? ' · No. ' + esc(o.number) : ''} · click for the notice</span>`;
  if (id === 'bz-contracts') { const a = o.awards[0]; return `<b class="y">${money(a.eff ?? a.value)}</b>${a.shared > 1 ? ' (share of framework)' : ''}<br><b>${esc(a.supplier)}</b><br><span class="muted">from ${esc(a.buyer || '?')} · ${esc((a.title || '').slice(0, 70))}</span>${o.awards.length > 1 ? `<br><span class="muted">+ ${o.awards.length - 1} more at ${esc(o.pc)}</span>` : ''}`; }
  if (id === 'bz-sales') return `<b class="b">${moneyFull(o.price)}</b> · ${typeName[o.type] || ''}${o.nb === 'Y' ? ' · new build' : ''}<br>${esc(o.addr)}<br><span class="muted">${esc(o.pc)} · sold ${esc(o.date)} · ${o.tenure === 'F' ? 'freehold' : 'leasehold'}</span>`;
  if (id === 'bz-jobs') return `<b>${esc(o.name)}</b><br><b class="vio">${o.jobs ? n(o.jobs) : '–'}</b> jobs located here (${esc(String(o.year || ''))})<br>Claimant rate <b class="${o.rate > 6 ? 'r' : ''}">${o.rate ?? '–'}%</b> of residents 16–64${o.adz ? `<br>Live adverts: <b>${n(o.adz.count)}</b>` : ''}`;
  if (id === 'bz-commute') { const d = o.d, m = o.m; return `<b>${esc(d.name)}</b><br>${m.ratio != null ? `<b class="${m.ratio > 1.1 ? 'r' : m.ratio < 0.9 ? 'b' : 'y'}">${Math.round(m.ratio * 100)}% of usual</b> <span class="muted">live TfL ${esc(m.liveAt || '')}</span>` : `<b class="y">${m.ofPeak != null ? Math.round(m.ofPeak * 100) + '% of its peak' : '–'}</b> <span class="muted">typical pattern now (no live reading)</span>`}<br><span class="muted">${d.office ? d.office.toFixed(1) + '× busier on a weekday than a Sunday' : ''}</span>`; }
  if (id === 'bz-off-dots' || id === 'bz-off-arcs') { const r = id === 'bz-off-arcs' ? o.r : o; return `<b class="r">${esc(r.country)}</b><br><b>${n(r.n)}</b> overseas entities registered to own UK property<br><span class="muted">${n(r.recent)} registered in the last ${B.D.offshore.recent_days} days</span>`; }
  return null;
}
function click(info) {
  const o = info.object, id = info.layer.id;
  if (id === 'bz-births') cardBirths(o.p);
  else if (id === 'bz-deaths') cardDeath(o);
  else if (id === 'bz-contracts') cardContracts(o);
  else if (id === 'bz-sales') cardSale(o);
  else if (id === 'bz-jobs') cardBorough(o);
  else if (id === 'bz-commute') cardDistrict(o.d);
  else if (id === 'bz-off-dots' || id === 'bz-off-arcs') cardCountry(id === 'bz-off-arcs' ? o.r : o);
}
function spark(arr, col, W = 320, H = 70, marker) {
  const max = Math.max(1, ...arr), pts = arr.map((v, i) => `${(i / Math.max(1, arr.length - 1) * W).toFixed(1)},${(H - 6 - v / max * (H - 16)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H + 2}" preserveAspectRatio="none"><polygon points="0,${H - 6} ${pts} ${W},${H - 6}" fill="${col}" fill-opacity=".18"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.6"/>${marker || ''}</svg>`;
}
function fly(pos, o) { map.flyTo({ center: pos, zoom: 15, pitch: 62, bearing: map.getBearing() + 40, duration: 2400, essential: true, ...o }); }
function focusOn(pos, label) { B.focus = { pos, label }; }
function cardBirths(p) {
  focusOn(p.pos, p.pc); fly(p.pos);
  const sic = B.D.births.sic || {}, cnt = new Map(); p.rows.forEach(r => cnt.set(r[4], (cnt.get(r[4]) || 0) + 1));
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4), names = p.rows.slice(-10).reverse(), st = parseD(B.D.births.start);
  LL.openCard(`<div class="kind">New companies · Companies House</div><h2>${esc(p.pc)} <span class="muted">${esc(p.borough || '')}</span></h2>
    <div class="big"><div><b class="g">${n(p.total)}</b><span>incorporated ${fmtD(st, SD)} – ${fmtD(parseD(B.D.births.end), SD)}</span></div><div><b>${(p.total / N).toFixed(1)}</b><span>per day</span></div></div>
    ${spark(Array.from(p.cnt), '#2fe3a0')}<div class="muted">New registrations per day at this address (Companies House free company data).</div>
    <ul class="cardlist">${top.map(([c, k]) => `<li><span>${esc(titleCase(sic[c] || (c ? 'SIC ' + c : 'No SIC code')))}</span><span>${k}</span></li>`).join('')}</ul>
    <div class="kind">Latest registered here</div>
    <ul class="cardlist">${names.map(r => `<li><span><a href="https://find-and-update.company-information.service.gov.uk/company/${esc(r[3])}" target="_blank" rel="noopener">${esc(titleCase(r[2]))}</a></span><span>${fmtD(st + r[1] * dayMs, SD)}</span></li>`).join('')}</ul>
    ${p.total > 150 ? `<div class="cardnote">${n(p.total)} companies in a month at one address is almost certainly a registered-office or company-formation address, not ${n(p.total)} offices. The register records where a company is registered, not where it trades.</div>` : ''}`);
}
function cardDeath(o) {
  focusOn(o.pos, titleCase(o.name)); fly(o.pos, { zoom: 15.5 });
  LL.openCard(`<div class="kind">${esc(kindLabel[o.kind] || o.cat)} · The Gazette</div><h2>${esc(titleCase(o.name))}</h2>
    <p>Notice published <b>${fmtD(o.date.getTime(), { weekday: 'long', day: 'numeric', month: 'long' })}</b>${o.number ? ` · company number ${esc(o.number)}` : ''}</p>
    ${o.addr ? `<p class="muted">Registered office: ${esc(o.addr)}</p>` : ''}
    <p><a href="${esc(o.url)}" target="_blank" rel="noopener">Read the notice on The Gazette ↗</a>${o.number ? ` · <a href="https://find-and-update.company-information.service.gov.uk/company/${esc(o.number)}" target="_blank" rel="noopener">Companies House ↗</a>` : ''}</p>
    <div class="cardnote">${o.kind === 'petition' ? 'A petition is a request to a court to wind the company up. It may be dismissed or paid off.' : o.kind === 'order' ? 'A court has ordered this company to be wound up.' : o.kind === 'admin' ? 'Administrators were appointed to try to rescue or sell the business.' : 'The shareholders resolved to wind the company up (usually with liquidators appointed).'} The location is The Gazette's own geotag of the registered office.</div>`);
}
function cardContracts(g) {
  focusOn(g.pos, g.awards[0].supplier); fly(g.pos, { zoom: 14.2 });
  LL.openCard(`<div class="kind">Government money · award notices</div><h2>${esc(g.pc)}</h2>
    <ul class="cardlist" style="font-size:12.5px">${g.awards.slice(0, 6).map(a => `<li style="display:block"><b>${esc(a.supplier)}</b> — <span class="y">${a.value ? moneyFull(a.value) : 'value not stated'}</span>${a.shared > 1 ? ` <span class="muted">(same figure listed for ${a.shared} suppliers: a framework ceiling, not money paid)</span>` : ''}<br><span class="muted">${esc(a.buyer || '')} · ${esc(a.title || '')}</span><br><span class="muted">${esc(a.src)} · awarded ${esc(a.date)} · located by ${esc(a.via)} · <a href="${esc(a.url || '#')}" target="_blank" rel="noopener">notice ↗</a></span></li>`).join('')}</ul>
    ${g.awards.length > 6 ? `<p class="muted">+ ${g.awards.length - 6} more awards at this postcode</p>` : ''}
    <div class="cardnote">Notice values are what the buyer published: often a maximum contract or framework value, not what has been paid. Column height uses the stated value divided by the number of suppliers sharing that notice.</div>`);
}
function cardSale(o) {
  focusOn(o.pos, moneyFull(o.price)); fly(o.pos, { zoom: 16.2 });
  const near = sales.filter(x => R(x.pos, o.pos) < 800), med = median(near.map(x => x.price));
  LL.openCard(`<div class="kind">Property sale · HM Land Registry</div><h2>${esc(o.addr)}</h2>
    <div class="big"><div><b class="b">${moneyFull(o.price)}</b><span>sold ${esc(o.date)}</span></div><div><b style="font-size:15px;line-height:27px">${esc(titleCase(typeName[o.type] || ''))}</b><span>${o.tenure === 'F' ? 'freehold' : 'leasehold'}${o.nb === 'Y' ? ' · new build' : ''}</span></div></div>
    <p class="muted">${esc(o.pc)} · ${esc(o.borough)}</p>
    ${o.type === 'O' || o.cat === 'B' ? `<div class="cardnote">Land Registry files this as ${o.type === 'O' ? '"other" property' : 'an "additional price paid" transaction'}${o.price >= 5e6 && o.type === 'O' ? ': at this price it is probably a whole building or a portfolio sold in one deal, recorded at a single address' : ''}.</div>` : ''}
    <p>${near.length} sales within 800 m in this window, median <b>${moneyFull(med)}</b>. This one is ${o.price > med ? `<b class="y">${(o.price / med).toFixed(1)}×</b> that` : `<b>${(o.price / med * 100).toFixed(0)}%</b> of that`}.</p>`);
}
function cardBorough(o) {
  focusOn(o.centre, o.name); map.flyTo({ center: o.centre, zoom: 11.3, pitch: 58, duration: 2200 });
  const rank = [...boroughRows].sort((a, b) => (b.jobs || 0) - (a.jobs || 0)).findIndex(x => x.code === o.code) + 1, adz = B.D.jobs.adzuna;
  LL.openCard(`<div class="kind">Where the jobs are · ONS via Nomis</div><h2>${esc(o.name)}</h2>
    <div class="big"><div><b class="vio">${o.jobs ? n(o.jobs) : '–'}</b><span>jobs located here · #${rank} of 33</span></div><div><b class="${o.rate > 6 ? 'r' : ''}">${o.rate ?? '–'}%</b><span>residents 16–64 claiming</span></div></div>
    <p class="muted">Jobs density ${o.density ?? '–'} jobs per resident aged 16–64 · ${o.claimants != null ? n(o.claimants) + ' claimants' : ''} (${esc(B.D.jobs.claimant_month || '')})</p>
    ${o.adz ? `<p>Live Adzuna adverts: <b>${n(o.adz.count)}</b>${o.adz.mean_salary ? ` · average advertised salary ${moneyFull(o.adz.mean_salary)}` : ''}</p>` : `<div class="cardnote">Live vacancies (who is advertising right now) need a free Adzuna API key: ${adz?.status === 'needs_key' ? 'coming soon.' : esc(adz?.error || 'unavailable.')} What you see here is where London's jobs are and where people are claiming, not open job adverts.</div>`}`);
}
function cardDistrict(d) {
  focusOn(d.pos, d.name.split(':')[0]); fly(d.pos, { zoom: 14.6 });
  const m = meter(d), prof = profileFor(d, S.day), W = 320, H = 70, max = Math.max(1, ...prof), x = S.slot / 95 * W, y = H - 6 - (m.flowNow || 0) / max * (H - 16);
  const liveDot = m.nl ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#ff4d5e" stroke="#fff"/>` : '';
  LL.openCard(`<div class="kind">The commute, measured · TfL</div><h2>${esc(d.name)}</h2><p class="muted">${esc(d.blurb)}</p>
    <div class="big">${m.ratio != null ? `<div><b class="${m.ratio > 1.1 ? 'r' : m.ratio < 0.9 ? 'b' : 'y'}">${Math.round(m.ratio * 100)}%</b><span>of usual · live ${esc(m.liveAt)}</span></div>` : `<div><b class="y">${m.ofPeak != null ? Math.round(m.ofPeak * 100) + '%' : '–'}</b><span>of peak · typical pattern now</span></div>`}
      <div><b>${n(d.mid)}</b><span>typical midweek entries+exits</span></div><div><b>${d.office ? d.office.toFixed(1) + '×' : '–'}</b><span>weekday vs Sunday</span></div></div>
    ${spark(prof, '#f5c451', W, H, `<line x1="${x}" x2="${x}" y1="0" y2="${H - 6}" stroke="#fff" stroke-opacity=".5" stroke-dasharray="2 2"/>${liveDot}`)}
    <div class="muted">Typical ${LL.DAYNAME[S.day]} for ${d.sts.map(s => esc(s.name)).join(' + ')} (TfL 2025 counts × TfL typical profile; an estimate). Dashed line = now${m.nl ? '; red dot = live-adjusted' : ''}.</div>
    <div class="cardnote">${m.ratio != null ? `${m.nl} station${m.nl > 1 ? 's' : ''} reporting live to TfL. "% of usual" is the live crowding reading divided by TfL's typical value for the same 15 minutes.` : 'TfL has no usable live reading here right now (or it is off-peak), so the meter shows the typical pattern, not a live one.'}</div>`);
}
function cardCountry(r) {
  focusOn(r.pos, r.country);
  map.flyTo({ center: [(r.pos[0] + LONDON_CENTRE[0]) / 2, (r.pos[1] + LONDON_CENTRE[1]) / 2], zoom: R(r.pos, LONDON_CENTRE) > 3e6 ? 2.6 : 4.2, pitch: 35, duration: 2200 });
  const o = B.D.offshore, share = r.n / o.total * 100;
  LL.openCard(`<div class="kind">Offshore London · Register of Overseas Entities</div><h2>${esc(r.country)}</h2>
    <div class="big"><div><b class="r">${n(r.n)}</b><span>overseas entities</span></div><div><b>${share.toFixed(1)}%</b><span>of all ${n(o.total)}</span></div><div><b>${n(r.recent)}</b><span>registered in last ${o.recent_days} days</span></div></div>
    <p>These are companies and bodies formed in ${esc(r.country)} that are registered at Companies House because they own, or want to own, land or property in the UK.</p>
    <div class="cardnote"><b>What this isn't:</b> the register does not say <i>which</i> property or whether it is in London, so arcs go to central London as a symbol, not to a building. The title-by-title list of London buildings (HM Land Registry OCOD) needs a free account and licence: <a href="${esc(o.ocod.url)}" target="_blank" rel="noopener">use-land-property-data.service.gov.uk ↗</a>. Not signed up yet.</div>`);
}

// ---------- panels ----------
function statusTag(files) {
  const sts = files.map(f => B.st[f]);
  if (sts.some(s => s === 'down' || s === 'missing')) return 'bad';
  if (sts.some(s => s === 'stale')) return 'stale';
  return 'ok';
}
function renderBrand() {
  const m = B.manifest, f = B.D, st = B.st;
  const pill = (label, s, tip) => `<span class="pill ${s === 'ok' ? 'ok' : s === 'key' ? 'key' : s === 'stale' ? 'info' : 'bad'}" title="${esc(tip || '')}">${s === 'ok' ? '●' : s === 'key' ? '🔑' : s === 'stale' ? '◐' : '✕'} ${label}</span>`;
  const sOf = k => st[k] === 'ok' ? 'ok' : st[k] === 'stale' ? 'stale' : 'down';
  const to = (k, label) => `${label}${f[k]?.end ? ' · to ' + fmtD(parseD(f[k].end), SD) : ''}`;
  const pills = [
    pill(to('births', 'Births'), sOf('births'), f.births?.error || st.births_err || 'Companies House monthly snapshot'),
    pill(to('deaths', 'Deaths'), sOf('deaths'), f.deaths?.error || st.deaths_err || 'The Gazette'),
    pill('Contracts', sOf('contracts'), f.contracts?.error || st.contracts_err || 'Contracts Finder + Find a Tender'),
    pill(to('sales', 'Sales'), sOf('sales'), f.sales?.error || st.sales_err || 'HM Land Registry'),
    pill('Jobs', sOf('jobs'), f.jobs?.error || st.jobs_err || 'ONS / Nomis'),
    pill('Offshore', sOf('offshore'), f.offshore?.error || st.offshore_err || 'Companies House ROE'),
    pill(S.errors.crowd || S.errors.net ? 'Commute down' : `Commute · ${S.crowdChecked || 0} live`, S.errors.crowd || S.errors.net ? 'down' : 'ok', S.errors.crowd || S.errors.net || 'TfL typical profiles + live crowding'),
    f.births_fresh?.status === 'needs_key' ? pill('Live registrations: needs free key', 'key', f.births_fresh.note) : f.births_fresh?.status === 'ok' ? pill('Registrations to ' + fmtD(parseD(f.births_fresh.end), SD), 'ok', '') : '',
    f.jobs?.adzuna?.status === 'needs_key' ? pill('Live vacancies: needs free key', 'key', f.jobs.adzuna.note) : '',
    f.offshore?.ocod ? pill('London buildings (OCOD): needs account', 'key', f.offshore.ocod.note) : '',
  ].join('');
  $('bz-brand').innerHTML = `<div class="bz-title">LONDON<span>·INC</span><i>.</i></div><div class="bz-sub">the city as a business: births, deaths, deals, jobs, towers</div>
    <div class="bz-built">data built <b>${m?.generated ? when(m.generated) : '–'}</b> <small>(London)</small><button id="bz-refresh" title="Reload business data and live TfL">↻</button></div><div id="bz-health">${pills}</div>`;
  $('bz-refresh').onclick = async () => { $('bz-refresh').classList.add('spin'); await loadData(); LL.refresh(false, true); renderAll(); };
}
function renderKpi() {
  const f = B.D, cm = commuteSummary();
  const ks = [
    ['churn', 'g', B.births ? n(B.births.total) : '–', B.births ? 'new companies in the window' : 'births unavailable'],
    ['churn', 'r', deaths.length ? n(B.deathsIn) : '–', deaths.length ? 'wound up in the window' : 'deaths unavailable'],
    ['commute', 'y', cm.v, cm.l],
    ['contracts', 'y', B.awards.length ? n(B.awards.length) : '–', B.awards.length ? 'contract awards · 30 days' : 'contracts unavailable'],
    ['sales', 'b', B.salesMedian ? money(B.salesMedian) : '–', B.salesMedian ? 'median home sale' : 'sales unavailable'],
    ['offshore', 'vio', offshoreRows.length ? n(f.offshore.total) : '–', 'overseas entities owning UK land'],
  ];
  $('bz-kpi').innerHTML = ks.map(([tab, c, v, l]) => `<div class="k ${c}" data-tab="${tab}"><b>${v}</b><span>${l}</span></div>`).join('');
  $('bz-kpi').querySelectorAll('.k').forEach(el => el.onclick = () => selectTab(el.dataset.tab));
}
function commuteSummary() {
  if (!districts.length) return { v: '…', l: 'commute meter' };
  const ms = districts.map(d => ({ d, m: meter(d) })), lv = ms.filter(x => x.m.ratio != null && x.m.typ > 0);
  if (lv.length >= 3) { const tw = lv.reduce((a, x) => a + x.m.typ, 0); return { v: Math.round(lv.reduce((a, x) => a + x.m.ratio * x.m.typ, 0) / tw * 100) + '%', l: 'office hubs vs usual (live)' }; }
  const tp = ms.filter(x => x.m.ofPeak != null), tw = tp.reduce((a, x) => a + x.m.peakFlow, 0);
  return { v: tp.length && tw ? Math.round(tp.reduce((a, x) => a + x.m.typ, 0) / tw * 100) + '%' : '–', l: `office hubs vs peak (typical${B.cm === 'now' ? '' : ' ' + S.day.slice(0, 3) + ' ' + LL.slotLabel(S.slot)})` };
}
function renderLayers() {
  const rows = LAYERS.map(l => { const st = l.files.length ? statusTag(l.files) : (S.errors.crowd || S.errors.net ? 'bad' : 'ok');
    return `<label class="bl"><input type="checkbox" data-k="${l.k}" ${B.show[l.k] ? 'checked' : ''}><i class="d" style="background:${l.col};box-shadow:0 0 8px ${l.col}"></i>${l.name}<em class="${st === 'bad' ? 'bad' : ''}">${st === 'bad' ? 'feed down' : st === 'stale' ? 'stale data' : l.tag}</em></label>`; }).join('');
  $('bz-layers').innerHTML = `<h3>Layers</h3>${rows}<label class="bl"><input type="checkbox" id="bz-bld" ${map.getLayer('3d-buildings') && map.getLayoutProperty('3d-buildings', 'visibility') === 'none' ? '' : 'checked'}><i class="d" style="background:#3a4560"></i>3D buildings</label><div class="bz-legend" id="bz-legend"></div>`;
  $('bz-layers').querySelectorAll('input[data-k]').forEach(i => i.onchange = e => { B.show[i.dataset.k] = e.target.checked; renderScrub(); renderLegend(); });
  $('bz-bld').onchange = e => { if (map.getLayer('3d-buildings')) map.setLayoutProperty('3d-buildings', 'visibility', e.target.checked ? 'visible' : 'none'); };
  renderLegend();
}
function renderLegend() {
  const parts = [];
  if (B.show.churn) parts.push(`<b class="g">Green</b> = companies incorporated (bigger = more at that address). <b class="r">Red</b> = winding-up / administration notices (fainter = older). <span class="y">Amber</span> = petitions.`);
  if (B.show.commute) parts.push(`<b>Commute</b>: column height ≈ station taps per 15 min; colour vs usual:<div class="grad" style="background:linear-gradient(90deg,#5aa9ff,#f5c451,#ff4d5e)"></div><div style="display:flex;justify-content:space-between"><span>quieter</span><span>usual</span><span>busier</span></div>Dim amber = typical pattern (no live reading).`);
  if (B.show.contracts) parts.push(`<b class="y">Gold</b> columns = award notices by supplier postcode; height = stated value (÷ suppliers sharing a notice).`);
  if (B.show.sales) parts.push(`<b class="b">Towers</b> = home sales; height and colour = price.<div class="grad" style="background:linear-gradient(90deg,#3764c8,#5aa9ff,#f5c451,#fff5d7)"></div><div style="display:flex;justify-content:space-between"><span>£100k</span><span>£1m</span><span>£4m+</span></div>`);
  if (B.show.jobs) parts.push(`<b class="vio">Boroughs</b> rise with jobs located there; colour = claimant rate.<div class="grad" style="background:linear-gradient(90deg,#3cd7aa,#ffc45a,#ff4d5e)"></div><div style="display:flex;justify-content:space-between"><span>low</span><span>claimant rate</span><span>high</span></div>`);
  if (B.show.offshore) parts.push(`<b class="r">Arcs</b> run from where overseas property-owning entities are registered to London (symbolic: the register has no addresses).`);
  $('bz-legend').innerHTML = parts.join('<br>') || '<span class="muted">Switch a layer on.</span>';
}
function statusNote(file, label) {
  const st = B.st[file], d = B.D[file];
  if (st === 'ok') return '';
  if (st === 'stale') return `<div class="note bad"><b>${label}: showing older data.</b> The latest refresh failed (${esc(d?.error || '')}); this is from ${esc(when(d?.generated))}.</div>`;
  return `<div class="note bad"><b>${label}: feed down.</b> ${esc(d?.error || B.st[file + '_err'] || 'could not be loaded')}. Nothing is shown rather than anything invented.</div>`;
}
const bar = (frac, col) => `<div class="bar"><i style="width:${Math.max(2, Math.min(100, frac * 100)).toFixed(0)}%;background:${col}"></i></div>`;
function panelChurn() {
  const f = B.D; let h = statusNote('births', 'Births') + statusNote('deaths', 'Deaths');
  if (B.births) {
    h += `<div class="ph">Born · Companies House</div><div class="note"><b class="g">${n(B.births.total)}</b> companies registered a London address between ${fmtD(parseD(f.births.start), SD)} and ${fmtD(parseD(f.births.end), SD)}. Source: Companies House's free monthly snapshot (${esc(f.births.snapshot)}).${f.births_fresh?.status === 'needs_key' ? '<br><span class="y">Registrations after that date, and a live stream, need a free Companies House API key: coming soon.</span>' : ''}</div>`;
    h += `<div class="ph">Busiest addresses</div>` + P.slice(0, 6).map(p => `<div class="row" data-pc="${esc(p.pc)}"><span class="nm">${esc(p.pc)}<small>${esc(p.borough || '')}</small></span><span class="v g">${n(p.total)}</span></div>`).join('');
  }
  if (deaths.length) {
    h += `<div class="ph">Dying · latest notices</div><div class="note"><b class="r">${n(B.deathsIn)}</b> London companies wound up, put into administration or resolved to close in the same window${B.deathsAfter ? `, plus <b class="r">${n(B.deathsAfter)}</b> since (to ${fmtD(parseD(f.deaths.end), SD)})` : ''}. Source: The Gazette. Each company counted once, at its strongest notice.</div>`;
    h += [...deaths].filter(x => x.kind !== 'petition').sort((a, b) => b.date - a.date).slice(0, 8).map(x => `<div class="row" data-d="${deaths.indexOf(x)}"><span class="nm">${esc(titleCase(x.name))}<small>${esc(kindLabel[x.kind])}</small></span><span class="v r">${fmtD(x.date.getTime(), SD)}</span></div>`).join('');
  }
  return h;
}
function panelCommute() {
  if (!districts.length) return `<div class="note bad"><b>Commute: TfL profiles not loaded.</b> ${esc(S.errors.net || '')}</div>`;
  const ms = districts.map(d => ({ d, m: meter(d) })).sort((a, b) => (b.m.ratio ?? b.m.ofPeak ?? 0) - (a.m.ratio ?? a.m.ofPeak ?? 0)), s = commuteSummary(), nLive = ms.filter(x => x.m.ratio != null).length;
  let h = `<div class="tabs" id="cmodes">${[['now', 'Now (live)'], ['am', '08:30 peak'], ['pm', '17:30 peak']].map(([k, l]) => `<button data-cm="${k}" class="${B.cm === k ? 'on' : ''}">${l}</button>`).join('')}</div><div class="note"><b class="y">${s.v}</b> ${esc(s.l)}. ${nLive ? `${nLive} of ${ms.length} office hubs have a live TfL reading right now.` : `No live readings for the office hubs yet (off-peak hours, or TfL has no data); showing TfL's typical pattern for ${LL.DAYNAME[S.day]} ${LL.slotLabel(S.slot)}.`}</div><div class="ph">Office districts</div>`;
  h += ms.map(({ d, m }) => { const v = m.ratio != null ? m.ratio : m.ofPeak, col = m.ratio != null ? (m.ratio > 1.1 ? '#ff4d5e' : m.ratio < 0.9 ? '#5aa9ff' : '#f5c451') : '#a98a3a';
    return `<div class="row" data-dist="${d.id}"><span class="nm">${esc(d.name.split(':')[0])}<small>${m.ratio != null ? 'live vs usual' : 'typical vs peak'}${d.office ? ' · ' + d.office.toFixed(1) + '× weekday/Sunday' : ''}</small>${bar(m.ratio != null ? Math.min(1, v / 1.5) : (v ?? 0), col)}</span><span class="v" style="color:${col}">${v != null ? Math.round(v * 100) + '%' : '–'}</span></div>`; }).join('');
  return h + `<div class="note">Live = TfL's crowding reading ÷ TfL's typical for the same 15 minutes. Typical = TfL's typical profile now ÷ that district's busiest slot. Weekday/Sunday = TfL 2025 counts: how office-driven a district is.</div>`;
}
function panelContracts() {
  const c = B.D.contracts; let h = statusNote('contracts', 'Contracts');
  if (!B.awards.length) return h;
  const top = [...B.awards].filter(a => a.value).sort((a, b) => (b.eff || 0) - (a.eff || 0)).slice(0, 8);
  h += `<div class="note"><b class="y">${n(B.awards.length)}</b> contract awards published in the last ${c.days} days went to suppliers with a London address (of ${n(c.awards_seen)} awards seen nationally; ${n(c.no_location)} had no findable location). Sources: Contracts Finder + Find a Tender.</div><div class="ph">Biggest (value ÷ suppliers on the notice)</div>`;
  h += top.map(a => `<div class="row" data-award="${B.awards.indexOf(a)}"><span class="nm">${esc(a.supplier)}<small>${esc(a.buyer || '')} · ${esc((a.title || '').slice(0, 60))}</small></span><span class="v y">${money(a.eff)}</span></div>`).join('');
  return h + `<div class="note">Stated notice values are often ceilings or multi-supplier framework limits, not money paid. ${n(c.london_without_value)} London awards state no value.</div>`;
}
function panelSales() {
  const s = B.D.sales; let h = statusNote('sales', 'Sales');
  if (!sales.length) return h;
  const top = [...sales].sort((a, b) => b.price - a.price).slice(0, 8), by = new Map();
  sales.forEach(x => { if (!by.has(x.borough)) by.set(x.borough, []); by.get(x.borough).push(x.price); });
  h += `<div class="note"><b class="b">${n(sales.length)}</b> London home sales registered ${fmtD(parseD(s.start), SD)} – ${fmtD(parseD(s.end), SD)}. Median <b>${moneyFull(B.salesMedian)}</b>. ${esc(s.note)}</div><div class="ph">Top sales</div>`;
  h += top.map(x => `<div class="row" data-sale="${sales.indexOf(x)}"><span class="nm">${esc(x.addr)}<small>${esc(x.pc)} · ${esc(x.date)}</small></span><span class="v b">${money(x.price)}</span></div>`).join('');
  h += `<div class="ph">Median by borough (top 6, 20+ sales)</div>` + [...by.entries()].filter(([, a]) => a.length >= 20).map(([k, a]) => [k, median(a), a.length]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, m, c]) => `<div class="row"><span class="nm">${esc(k)}<small>${c} sales</small></span><span class="v b">${money(m)}</span></div>`).join('');
  return h;
}
function panelJobs() {
  const j = B.D.jobs; let h = statusNote('jobs', 'Jobs');
  if (!boroughRows.length) return h;
  const rows = [...boroughRows].sort((a, b) => (b.jobs || 0) - (a.jobs || 0)), total = rows.reduce((a, r) => a + (r.jobs || 0), 0);
  h += `<div class="note"><b class="vio">${n(total)}</b> jobs located in London's 33 boroughs (${esc(String(rows[0]?.year || ''))}). Claimant counts: ${esc(j.claimant_month || '')}. Source: ONS via Nomis.</div>`;
  h += j.adzuna?.status === 'ok' ? '' : `<div class="note key"><b>Live vacancies: needs a free Adzuna API key — coming soon.</b> The page is wired for it. Until then this shows where the jobs <i>are</i> and how many residents are claiming, not open adverts.</div>`;
  h += `<div class="ph">Most jobs</div>` + rows.slice(0, 8).map(r => `<div class="row" data-b="${r.code}"><span class="nm">${esc(r.name)}<small>claimants ${r.rate ?? '–'}% of residents 16–64</small>${bar(r.jobs / B.jobsMax, '#a78bfa')}</span><span class="v vio">${(r.jobs / 1000).toFixed(0)}k</span></div>`).join('');
  h += `<div class="ph">Highest claimant rate</div>` + [...boroughRows].sort((a, b) => (b.rate || 0) - (a.rate || 0)).slice(0, 4).map(r => `<div class="row" data-b="${r.code}"><span class="nm">${esc(r.name)}<small>${(r.jobs / 1000).toFixed(0)}k jobs here</small></span><span class="v r">${r.rate}%</span></div>`).join('');
  return h;
}
function panelOffshore() {
  const o = B.D.offshore; let h = statusNote('offshore', 'Offshore');
  if (!offshoreRows.length) return h;
  h += `<div class="note"><b class="r">${n(o.total)}</b> overseas entities are on Companies House's Register of Overseas Entities: foreign companies that own, or have applied to own, UK land. Snapshot ${esc(o.snapshot)}.</div>`;
  h += `<div class="note key"><b>London buildings (OCOD): needs a free account.</b> HM Land Registry's list of which London titles overseas companies own needs a free sign-up and licence at use-land-property-data.service.gov.uk. We haven't signed up, so there is no building-level data here. This register has countries, not addresses.</div>`;
  h += `<div class="ph">Where they're registered</div>` + offshoreRows.slice(0, 12).map(r => `<div class="row" data-c="${esc(r.code)}"><span class="nm">${esc(r.country)}${bar(r.n / B.offMax, '#ff4d5e')}</span><span class="v r">${n(r.n)}</span></div>`).join('');
  return h;
}
function setCommuteMode(m) {
  B.cm = m; const t = LL.londonNow();
  if (m === 'now') { S.followNow = true; S.day = t.day; S.slot = t.slot; }
  else { S.followNow = false; S.day = ['SAT', 'SUN'].includes(t.day) ? 'TUE' : t.day; S.slot = m === 'am' ? 34 : 70; }
  renderRight(); renderKpi();
}
const PANELS = { churn: panelChurn, commute: panelCommute, contracts: panelContracts, sales: panelSales, jobs: panelJobs, offshore: panelOffshore };
function renderRight() {
  const el = $('bz-right');
  if (!el.dataset.built) { el.dataset.built = 1; el.innerHTML = `<h3 style="margin-bottom:6px">London, Inc. <small style="float:right;color:#8f98ac;text-transform:none;letter-spacing:0">every number is real</small></h3><div class="tabs" id="bz-tabs"></div><div id="bz-panel"></div>`; }
  $('bz-tabs').innerHTML = TABS.map(([k, l]) => `<button data-t="${k}" class="${B.tab === k ? 'on' : ''}">${l}</button>`).join('');
  $('bz-tabs').querySelectorAll('button').forEach(b => b.onclick = () => selectTab(b.dataset.t));
  const P2 = $('bz-panel'), sc = P2.scrollTop;
  P2.innerHTML = PANELS[B.tab](); P2.scrollTop = sc;
  P2.querySelectorAll('[data-cm]').forEach(e => e.onclick = () => setCommuteMode(e.dataset.cm));
  P2.querySelectorAll('[data-pc]').forEach(e => e.onclick = () => cardBirths(P.find(p => p.pc === e.dataset.pc)));
  P2.querySelectorAll('[data-d]').forEach(e => e.onclick = () => cardDeath(deaths[+e.dataset.d]));
  P2.querySelectorAll('[data-dist]').forEach(e => e.onclick = () => cardDistrict(districts.find(d => d.id === e.dataset.dist)));
  P2.querySelectorAll('[data-award]').forEach(e => e.onclick = () => { const a = B.awards[+e.dataset.award]; cardContracts(contracts.find(g => g.pc === a.pc)); });
  P2.querySelectorAll('[data-sale]').forEach(e => e.onclick = () => cardSale(sales[+e.dataset.sale]));
  P2.querySelectorAll('[data-b]').forEach(e => e.onclick = () => cardBorough(boroughRows.find(r => r.code === e.dataset.b)));
  P2.querySelectorAll('[data-c]').forEach(e => e.onclick = () => cardCountry(offshoreRows.find(r => r.code === e.dataset.c)));
}
const CAM = { churn: { center: [-0.105, 51.515], zoom: 11.9, pitch: 55, bearing: -17 }, commute: { center: [-0.075, 51.515], zoom: 12.4, pitch: 62, bearing: -20 }, contracts: { center: [-0.1, 51.51], zoom: 11.7, pitch: 58, bearing: -17 }, sales: { center: [-0.13, 51.5], zoom: 11.4, pitch: 60, bearing: -17 }, jobs: { center: [-0.1, 51.49], zoom: 10.6, pitch: 58, bearing: -12 }, offshore: { center: [-28, 38], zoom: 2.1, pitch: 28, bearing: 0 } };
function selectTab(k, noFly) {
  B.tab = k; B.focus = null; $('card').classList.add('hidden');
  // each tab is a scene: its layer on, the other scene layers off (the checkboxes let you stack more)
  B.show = { churn: k === 'churn', commute: k === 'churn' || k === 'commute', contracts: k === 'contracts', sales: k === 'sales', jobs: k === 'jobs', offshore: k === 'offshore' };
  if (k === 'commute') B.show.churn = false;
  renderLayers(); renderRight(); renderScrub();
  if (!noFly) map.flyTo({ ...CAM[k], duration: 2600, essential: true });
}

// ---------- "Where's the action right now?" ----------
// Picks an office district, then says why using real numbers from every layer within walking distance.
function action() {
  if (!districts.length) { LL.openCard("<p>TfL station data hasn't loaded, so I can't rank districts yet.</p>"); return; }
  const rows = districts.map(d => {
    const m = meter(d), nb = P.reduce((a, p) => a + (R(p.pos, d.pos) < 700 ? p.total : 0), 0), nd = deaths.filter(x => R(x.pos, d.pos) < 900).length;
    const cs = contracts.filter(g => R(g.pos, d.pos) < 1500), cv = cs.reduce((a, g) => a + g.eff, 0), ss = sales.filter(x => R(x.pos, d.pos) < 900);
    return { d, m, nb, nd, cs, cv, ss, score: Math.log10(1 + nb) + Math.log10(1 + cv / 1e4) * 0.6 + Math.log10(1 + ss.length) * 0.5 + (m.ratio != null ? m.ratio : (m.ofPeak ?? 0.5)) };
  }).sort((a, b) => b.score - a.score);
  const top = rows.slice(0, 5), pick = top[Math.floor(Math.random() * top.length)], d = pick.d;
  const bestCo = pick.cs.flatMap(g => g.awards).sort((a, b) => (b.eff || 0) - (a.eff || 0))[0], bestSale = [...pick.ss].sort((a, b) => b.price - a.price)[0];
  const topP = P.filter(p => R(p.pos, d.pos) < 700).sort((a, b) => b.total - a.total)[0], lines = [];
  lines.push(pick.m.ratio != null ? `<li><b class="${pick.m.ratio > 1.1 ? 'r' : pick.m.ratio < 0.9 ? 'b' : 'y'}">${Math.round(pick.m.ratio * 100)}% of its usual crowd</b> right now (TfL live reading ${esc(pick.m.liveAt)})</li>` : `<li>Commute: at <b class="y">${pick.m.ofPeak != null ? Math.round(pick.m.ofPeak * 100) + '%' : '–'}</b> of its busiest ${LL.DAYNAME[S.day]} slot (typical pattern, no live reading)</li>`);
  if (B.births) lines.push(`<li><b class="g">${n(pick.nb)}</b> companies registered within 700 m, ${fmtD(parseD(B.D.births.start), SD)}–${fmtD(parseD(B.D.births.end), SD)}${topP ? `, ${n(topP.total)} of them at ${esc(topP.pc)}` : ''}</li>`);
  if (deaths.length) lines.push(`<li><b class="r">${n(pick.nd)}</b> insolvency notices within 900 m over the same period to date</li>`);
  if (pick.cs.length) lines.push(`<li>Government money: <b class="y">${pick.cs.reduce((a, g) => a + g.awards.length, 0)}</b> awards to suppliers within 1.5 km${bestCo ? `, biggest <b>${esc(bestCo.supplier)}</b> (${money(bestCo.eff)}) from ${esc(bestCo.buyer || '?')}` : ''}</li>`);
  if (bestSale) lines.push(`<li>Property: <b class="b">${pick.ss.length}</b> sales within 900 m; the top one is <b>${esc(bestSale.addr)}</b> at <b>${moneyFull(bestSale.price)}</b></li>`);
  const missions = ['Walk the block and count the brass plates: which of those new firms actually has a door here?', 'Buy a coffee within sight of the station and watch who comes out at the next peak.', 'Find the biggest building nearby and look up who owns it on Companies House.', 'Ask someone at the nearest reception how long their firm has been at this address.'];
  B.focus = { pos: d.pos, label: d.name.split(':')[0] };
  B.show = { churn: true, commute: true, contracts: pick.cs.length > 0, sales: !!bestSale, jobs: false, offshore: false };
  renderLayers(); renderScrub();
  map.flyTo({ center: d.pos, zoom: 14.7, pitch: 64, bearing: map.getBearing() + 100 + Math.random() * 100, duration: 4800, curve: 1.8, essential: true });
  LL.openCard(`<div class="kind">▮ Go here right now</div><h2>${esc(d.name)}</h2><p class="muted">${esc(d.blurb)}</p><div class="kind" style="margin-top:8px">Why here, why now</div><ul class="why">${lines.join('')}<li class="muted">Picked at random from the 5 highest-scoring of ${rows.length} office districts, scored on new firms, contract money, home sales and crowd</li></ul><div class="mission biz">▮ ${missions[Math.floor(Math.random() * missions.length)]}</div>`);
}

// ---------- lifecycle ----------
function renderAll() { renderBrand(); renderKpi(); renderLayers(); renderRight(); renderScrub(); }
function init(ll) {
  if (B.inited) return; B.inited = true; LL = ll; S = ll.S; map = ll.map; $ = ll.$; esc = ll.esc; n = ll.n;
  buildDistricts();
  $('bz-go').onclick = action;
  $('bz-home').onclick = () => { B.focus = null; $('card').classList.add('hidden'); map.flyTo({ ...CAM[B.tab], duration: 2600 }); };
  const sheet = (btn, id, other) => $(btn).onclick = () => { $(other).classList.remove('open'); $('card').classList.add('hidden'); $(id).classList.toggle('open'); };
  sheet('bz-mL', 'bz-layers', 'bz-right'); sheet('bz-mR', 'bz-right', 'bz-layers');
  addEventListener('keydown', e => { if (!B.active || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return; if (e.key === ' ') { e.preventDefault(); B.playing ? stopPlay() : startPlay(); } });
  setInterval(() => { if (B.active && !document.hidden) { renderKpi(); renderBrand(); if (B.tab === 'commute') renderRight(); } }, 5000);
  B.ready = loadData().then(() => { if (B.active) { renderAll(); maybeAutoplay(); } });
}
function maybeAutoplay() { if (B.active && B.show.churn && B.births && !B.autoPlayed && !new URLSearchParams(location.search).has('still')) { B.autoPlayed = true; startPlay(); } }
async function enter(first) {
  B.active = true; B.cm = 'now'; S.show.pulse = true; S.followNow = true; S.playing = false;
  const t = LL.londonNow(); S.day = t.day; S.slot = t.slot;
  renderAll();
  map.flyTo({ ...CAM[B.tab], duration: first ? 0 : 2400 });
  if (B.ready) B.ready.then(() => setTimeout(maybeAutoplay, 1200));
  if (!first) LL.refresh(false, true);
}
function leave() { B.active = false; stopPlay(); B.focus = null; B.cm = 'now'; S.followNow = true; const t = LL.londonNow(); S.day = t.day; S.slot = t.slot; }
function refreshed() { if (B.active) { renderKpi(); renderBrand(); if (B.tab === 'commute') renderRight(); } }
window.BIZ = { init, enter, leave, layers, tip, click, refreshed, officeStationIds: () => DISTRICTS.flatMap(d => d.st), _B: B, _api: { selectTab, action, setDay, startPlay, stopPlay, cardBirths, cardDeath } };
})();
