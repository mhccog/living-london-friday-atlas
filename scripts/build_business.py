#!/usr/bin/env python3
"""Build the JSON files behind Living London's Business mode (data/business/*.json).

Run by .github/workflows/deploy.yml (daily) or by hand:  python3 scripts/build_business.py [--only births,deaths,...]

Rules: real data only. If a source fails the layer's file records status "down" with the error (and keeps the last good
data from the committed seed, flagged stale) - numbers are never made up. API keys are read ONLY from environment
variables (GitHub Actions secrets): COMPANIES_HOUSE_API_KEY, ADZUNA_APP_ID, ADZUNA_APP_KEY. Nothing is written to disk
that contains a key. Python standard library only.
"""
import csv, io, json, os, re, sys, time, zipfile, base64, argparse, collections, datetime as dt
import urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('BIZ_OUT', os.path.join(ROOT, 'data', 'business'))
WORK = os.environ.get('BIZ_WORK', '/tmp/ll-biz')
UA = {'User-Agent': 'living-london-business/1.0 (+https://github.com/mhccog/living-london-friday-atlas)', 'Accept': 'application/json'}
os.makedirs(OUT, exist_ok=True); os.makedirs(WORK, exist_ok=True)
NOW = dt.datetime.now(dt.timezone.utc)
csv.field_size_limit(10**9)

def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)

def http(url, data=None, headers=None, timeout=90, tries=4, raw=False):
    h = dict(UA); h.update(headers or {})
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
            return b if raw else json.loads(b)
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(2 * (i + 1))

def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 1000: return path
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r, open(path + '.part', 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b)
    os.replace(path + '.part', path); return path

def write(name, obj):
    p = os.path.join(OUT, name)
    with open(p + '.tmp', 'w') as f: json.dump(obj, f, separators=(',', ':'), ensure_ascii=False)
    os.replace(p + '.tmp', p)
    log('wrote', name, os.path.getsize(p) // 1024, 'KB')

def read_seed(name):
    try:
        with open(os.path.join(ROOT, 'data', 'business', name)) as f: return json.load(f)
    except Exception: return None

def fail(name, source, err, extra=None):
    """Layer failed: keep the previous good file (flagged stale) or write an honest 'down' stub. Never fabricate."""
    log('FAILED', name, err)
    old = read_seed(name)
    if old and old.get('status') in ('ok', 'stale'):
        old['status'] = 'stale'; old['error'] = str(err)[:300]; write(name, old)
    else:
        write(name, {'status': 'down', 'source': source, 'error': str(err)[:300], 'generated': NOW.isoformat(timespec='seconds'), **(extra or {})})

# ---------------- London geometry + geocoding ----------------
with open(os.path.join(ROOT, 'data', 'business', 'boroughs.json')) as f: BOROUGHS = json.load(f)
RINGS = []
for ft in BOROUGHS['features']:
    g = ft['geometry']; polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    for p in polys: RINGS.append((ft['properties']['LAD24CD'], p[0]))
def borough_of(lon, lat):
    for code, ring in RINGS:
        ins = False; j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]; xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi: ins = not ins
            j = i
        if ins: return code
    return None

_geo = {}
def norm_pc(p):
    p = re.sub(r'\s+', '', (p or '').upper())
    return (p[:-3] + ' ' + p[-3:]) if re.fullmatch(r'[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}', p) else None
def geocode(pcs):
    """postcodes.io bulk lookup -> {postcode: (lon, lat, region, admin_district)}. Keyless."""
    need = sorted({p for p in pcs if p and p not in _geo})
    chunks = [need[i:i + 100] for i in range(0, len(need), 100)]
    def one(ch):
        try:
            d = http('https://api.postcodes.io/postcodes', data=json.dumps({'postcodes': ch}).encode(), headers={'Content-Type': 'application/json'}, timeout=60)
            return [(r['query'], r['result']) for r in d['result']]
        except Exception as e:
            log('geocode chunk failed', e); return [(q, False) for q in ch]
    with ThreadPoolExecutor(4) as ex:
        for res in ex.map(one, chunks):
            for q, r in res:
                if r is False: continue          # transient failure: leave unresolved (not cached as missing)
                _geo[q] = (r['longitude'], r['latitude'], r.get('region'), r.get('admin_district')) if r and r.get('longitude') else None
    return _geo

LON_AREAS = set('E EC N NW SE SW W WC BR CR DA EN HA IG KT RM SM TW UB WD'.split())
def maybe_london_pc(p):
    m = re.match(r'([A-Z]{1,2})\d', p or '')
    return bool(m and m.group(1) in LON_AREAS)

def norm_name(s):
    s = (s or '').upper().replace('&', ' AND ')
    s = re.sub(r'[^A-Z0-9 ]', ' ', s); s = re.sub(r'\bLTD\b', 'LIMITED', s)
    return ' '.join(s.split())

# ---------------- Contracts (Contracts Finder + Find a Tender, OCDS, keyless) ----------------
CONTRACT_DAYS = 30
PC_RE = re.compile(r'\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b', re.I)
def paged(first, maxp=80):
    u, n = first, 0
    while u and n < maxp:
        d = http(u); n += 1
        for r in d.get('releases', []): yield r
        u = (d.get('links') or {}).get('next')
def fetch_contracts():
    since = (NOW - dt.timedelta(days=CONTRACT_DAYS)).date()
    cf = list(paged(f'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?publishedFrom={since}&publishedTo={NOW.date()}&stages=award&limit=100'))
    fts = list(paged(f'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?updatedFrom={since}T00:00:00&stages=award&limit=100'))
    log('contracts raw', len(cf), len(fts))
    rows = []; seen = set()
    for src, rels in (('Contracts Finder', cf), ('Find a Tender', fts)):
        for r in rels:
            parties = {p['id']: p for p in r.get('parties', [])}
            cvals = {c.get('awardID'): (c.get('value') or {}).get('amount') for c in (r.get('contracts') or []) if c.get('awardID')}
            cdates = {c.get('awardID'): c.get('dateSigned') for c in (r.get('contracts') or []) if c.get('awardID')}
            buyer = (r.get('buyer') or {}).get('name') or next((p['name'] for p in parties.values() if 'buyer' in p.get('roles', [])), None)
            tender = r.get('tender') or {}
            for a in r.get('awards', []):
                if a.get('status') not in (None, 'active'): continue
                v = (a.get('value') or {}).get('amount') or cvals.get(a.get('id'))
                date = (a.get('date') or cdates.get(a.get('id')) or a.get('datePublished') or r.get('date') or '')[:10]
                url = next((d['url'] for d in a.get('documents', []) if d.get('url')), None)
                if not url and src == 'Find a Tender': url = 'https://www.find-tender.service.gov.uk/Notice/' + str(r.get('id'))
                for s in a.get('suppliers', []):
                    p = parties.get(s['id'], {}); ad = p.get('address') or {}
                    m = PC_RE.search(' '.join(str(x) for x in ad.values()))
                    ident = p.get('identifier') or {}
                    coh = ident.get('id') if ident.get('scheme') == 'GB-COH' else None
                    if not coh and re.fullmatch(r'GB-COH-(\w+)', s.get('id', '')): coh = s['id'][7:]
                    key = (norm_name(s['name']), norm_name(buyer or ''), round(v or 0), (a.get('title') or tender.get('title') or '')[:40])
                    if key in seen: continue
                    seen.add(key)
                    rows.append({'supplier': s['name'], 'coh': coh, 'pc': norm_pc(m.group(0)) if m else None, 'value': v, 'date': date, 'buyer': buyer,
                                 'title': a.get('title') or tender.get('title'), 'desc': (tender.get('description') or '')[:220], 'url': url, 'src': src,
                                 'cat': (tender.get('mainProcurementCategory')), 'sme': (p.get('details') or {}).get('scale')})
    return rows

# ---------------- Companies House free snapshot pass ----------------
CH_HTML = 'https://download.companieshouse.gov.uk/en_output.html'
def ch_snapshot_url():
    html = http(CH_HTML, raw=True).decode('utf8', 'replace')
    names = re.findall(r'BasicCompanyDataAsOneFile-(\d{4}-\d{2}-\d{2})\.zip', html)
    if not names: raise RuntimeError('no BasicCompanyDataAsOneFile link on ' + CH_HTML)
    d = sorted(names)[-1]
    return d, f'https://download.companieshouse.gov.uk/BasicCompanyDataAsOneFile-{d}.zip'
def parse_d(s):
    try: return dt.datetime.strptime(s, '%d/%m/%Y').date()
    except Exception: return None
def ch_pass(need_numbers, need_names):
    snap, url = ch_snapshot_url(); log('Companies House snapshot', snap, url)
    zp = download(url, os.path.join(WORK, f'ch-{snap}.zip'))
    births_raw, oe, byname, bynum, total = [], collections.Counter(), {}, {}, 0
    oe_recent = collections.Counter(); maxd = None
    with zipfile.ZipFile(zp) as z:
        name = z.namelist()[0]
        with z.open(name) as raw:
            rd = csv.reader(io.TextIOWrapper(raw, encoding='utf-8-sig', newline=''))
            h = [x.strip() for x in next(rd)]; ix = {n: i for i, n in enumerate(h)}
            iN, iC, iPC, iCat, iSt, iOr, iD = ix['CompanyName'], ix['CompanyNumber'], ix['RegAddress.PostCode'], ix['CompanyCategory'], ix['CompanyStatus'], ix['CountryOfOrigin'], ix['IncorporationDate']
            iS1 = ix['SICCode.SicText_1']; iA1 = ix['RegAddress.AddressLine1']; iT = ix['RegAddress.PostTown']
            for row in rd:
                if len(row) <= iD: continue
                total += 1
                d = parse_d(row[iD]) if row[iD] else None
                if d and (maxd is None or d > maxd) and d <= NOW.date(): maxd = d
                cat = row[iCat]
                if cat == 'Overseas Entity':
                    oe[(row[iOr] or '').strip().upper()] += 1
                    if d and d >= NOW.date() - dt.timedelta(days=120): oe_recent[(row[iOr] or '').strip().upper()] += 1
                    continue
                num = row[iC]
                if num in need_numbers: bynum[num] = (row[iPC], row[iN])
                nn = norm_name(row[iN]) if need_names else None
                if nn and nn in need_names:
                    if nn not in byname or row[iSt].startswith('Active'): byname[nn] = (row[iPC], num)
                if d and d >= NOW.date() - dt.timedelta(days=75) and maybe_london_pc(row[iPC].strip().upper()):
                    births_raw.append((d, row[iN], num, row[iPC], row[iS1], cat, row[iA1], row[iT]))
    # the snapshot is dated the 1st; incorporations on that date are a stray handful, so the complete window ends the day before
    maxd = min(maxd, dt.date.fromisoformat(snap) - dt.timedelta(days=1))
    log('CH rows', total, 'max incorporation date', maxd, 'recent london-ish', len(births_raw), 'overseas entities', sum(oe.values()))
    return {'snapshot': snap, 'url': url, 'maxd': maxd, 'births_raw': births_raw, 'oe': oe, 'oe_recent': oe_recent, 'bynum': bynum, 'byname': byname, 'total': total}

def cat_short(c):
    c = c or ''
    if c.startswith('Private Limited') or c.startswith('PRI/') or c.startswith('Private Unlimited'): return 'ltd'
    if 'Liability Partnership' in c: return 'llp'
    if 'Limited Partnership' in c: return 'lp'
    if 'Community Interest' in c: return 'cic'
    if 'Public Limited' in c: return 'plc'
    return 'other'

def build_births(ch):
    maxd = ch['maxd']; start = maxd - dt.timedelta(days=29)
    raw = [r for r in ch['births_raw'] if start <= r[0] <= maxd]
    pcs = {norm_pc(r[3]) for r in raw}; pcs.discard(None)
    g = geocode(pcs)
    table, tix, rows, miss, nonlon = [], {}, [], 0, 0
    for d, name, num, pc, sic, cat, a1, town in sorted(raw, key=lambda r: r[0]):
        p = norm_pc(pc); gg = g.get(p) if p else None
        if not gg: miss += 1; continue
        if gg[2] != 'London': nonlon += 1; continue
        if p not in tix: tix[p] = len(table); table.append([p, round(gg[0], 5), round(gg[1], 5), gg[3]])
        rows.append([tix[p], (d - start).days, name, num, (sic or '').split(' - ')[0], cat_short(cat)])
    sic_names = {}
    for r in raw:
        if r[4] and ' - ' in r[4]: c, t = r[4].split(' - ', 1); sic_names.setdefault(c, t)
    used = {r[4] for r in rows}
    out = {'status': 'ok', 'source': 'Companies House Free Company Data Product (monthly snapshot)', 'source_url': 'https://download.companieshouse.gov.uk/en_output.html',
           'licence': 'Contains public sector information licensed under the Open Government Licence v3.0',
           'snapshot': ch['snapshot'], 'start': start.isoformat(), 'end': maxd.isoformat(), 'generated': NOW.isoformat(timespec='seconds'),
           'count': len(rows), 'geocode_missed': miss, 'outside_london': nonlon, 'postcodes': table, 'sic': {k: v for k, v in sic_names.items() if k in used},
           'rows': rows, 'cols': ['pcIdx', 'dayOffset', 'name', 'number', 'sic', 'kind']}
    write('births.json', out); return out

def build_offshore(ch):
    from_centroids = json.load(open(os.path.join(ROOT, 'data', 'business', 'country_centroids.json')))
    rows = []; undrawn = 0; tot = sum(ch['oe'].values())
    for c, n in ch['oe'].most_common():
        if not c.strip(): undrawn += n; continue
        key = {'BRITISH VIRGIN ISLANDS': 'VIRGIN ISLANDS, BRITISH', 'REPUBLIC OF CYPRUS': 'CYPRUS', 'REPUBLIC OF NORTH MACEDONIA': 'NORTH MACEDONIA'}.get(c, c)
        ll = from_centroids.get(key)
        if not ll: undrawn += n; continue
        rows.append({'country': key.title().replace('Of', 'of').replace('And', 'and'), 'code': key, 'n': n, 'recent': ch['oe_recent'].get(c, 0), 'lon': ll[0], 'lat': ll[1]})
    merged = {}
    for r in rows:
        if r['code'] in merged: merged[r['code']]['n'] += r['n']; merged[r['code']]['recent'] += r['recent']
        else: merged[r['code']] = r
    rows = sorted(merged.values(), key=lambda r: -r['n'])
    out = {'status': 'ok', 'source': 'Companies House Register of Overseas Entities (via the free company data snapshot)', 'source_url': 'https://download.companieshouse.gov.uk/en_output.html',
           'snapshot': ch['snapshot'], 'generated': NOW.isoformat(timespec='seconds'), 'total': tot, 'undrawn': undrawn, 'rows': rows,
           'recent_days': 120,
           'ocod': {'status': 'needs_account', 'note': 'The title-by-title list of London buildings owned by overseas companies (HM Land Registry OCOD) needs a free account and licence at use-land-property-data.service.gov.uk. Not signed up, so no building-level data is shown.', 'url': 'https://use-land-property-data.service.gov.uk/datasets/ocod'}}
    write('offshore.json', out); return out

# ---------------- The Gazette: insolvency notices (keyless JSON feed with a geo point per notice) ----------------
DEATH_CATS = {'Winding-Up Orders': ('order', 4), 'Appointment of Administrators': ('admin', 3), 'Resolutions for Winding-up': ('resolution', 2), 'Resolutions for Winding Up': ('resolution', 2),
              'Petitions to Wind Up (Companies)': ('petition', 1)}
def build_deaths(start):
    base = 'https://www.thegazette.co.uk/all-notices/notice/data.json?categorycode=G205010000&start-publish-date={s}&end-publish-date={e}&results-page-size=100&results-page={p}'
    entries, p, total = [], 1, None
    while True:
        d = http(base.format(s=start, e=NOW.date(), p=p), timeout=120)
        es = d.get('entry') or []
        if isinstance(es, dict): es = [es]
        entries += es; total = int(d['f:total'])
        if len(entries) >= total or not es or p >= 200: break
        p += 1
    log('gazette notices', len(entries), 'of', total)
    best = {}
    for e in entries:
        cat = (e.get('category') or {}).get('@term'); gp = e.get('geo:Point')
        if cat not in DEATH_CATS or not gp: continue
        lon, lat = float(gp['geo:long']), float(gp['geo:lat'])
        if not borough_of(lon, lat): continue
        kind, rank = DEATH_CATS[cat]
        name = (e.get('title') or '').strip()
        content = re.sub(r'<[^>]+>', ' ', e.get('content') or ''); content = re.sub(r'\s+', ' ', content)
        m = re.search(r'Company Number:?\s*([A-Z0-9]{6,8})', content, re.I)
        o = re.search(r'Registered [Oo]ffice:?\s*(.{0,120}?)(?:Principal|Type of|Nature|$)', content)
        rec = {'name': name, 'lon': round(lon, 5), 'lat': round(lat, 5), 'date': (e.get('published') or '')[:10], 'kind': kind, 'rank': rank, 'cat': cat,
               'number': m.group(1) if m else None, 'addr': (o.group(1).strip().rstrip('…').strip() if o else None), 'url': e.get('id', '').replace('/id/notice/', '/notice/')}
        k = name.upper()
        if k not in best or rank > best[k]['rank'] or (rank == best[k]['rank'] and rec['date'] > best[k]['date']): best[k] = rec
    rows = sorted(best.values(), key=lambda r: r['date'])
    start_d = dt.date.fromisoformat(str(start))
    out = {'status': 'ok', 'source': 'The Gazette - corporate insolvency notices (open JSON feed)', 'source_url': 'https://www.thegazette.co.uk/insolvency', 'licence': 'Open Government Licence v3.0',
           'start': str(start), 'end': str(NOW.date()), 'generated': NOW.isoformat(timespec='seconds'), 'notices_scanned': len(entries), 'count': len(rows),
           'rows': [[r['lon'], r['lat'], (dt.date.fromisoformat(r['date']) - start_d).days, r['name'], r['kind'], r['number'], r['addr'], r['url'], r['cat']] for r in rows if r['date']],
           'cols': ['lon', 'lat', 'dayOffset', 'name', 'kind', 'number', 'registeredOffice', 'url', 'category']}
    write('deaths.json', out); return out

# ---------------- Contracts: resolve supplier location ----------------
def build_contracts(rows, ch):
    for r in rows:
        if not r['pc'] and r['coh'] and r['coh'] in ch['bynum']: r['pc'] = norm_pc(ch['bynum'][r['coh']][0]); r['via'] = 'Companies House number'
        if not r['pc']:
            h = ch['byname'].get(norm_name(r['supplier']))
            if h: r['pc'] = norm_pc(h[0]); r['via'] = 'Companies House name match'
        if r['pc'] and 'via' not in r: r['via'] = 'address in notice'
    pcs = {r['pc'] for r in rows if r['pc']}; g = geocode(pcs)
    out_rows, nopc, nonlon, novalue = [], 0, 0, 0
    for r in rows:
        if not r['pc']: nopc += 1; continue
        gg = g.get(r['pc'])
        if not gg or gg[2] != 'London': nonlon += 1; continue
        if not r['value']: novalue += 1
        out_rows.append([round(gg[0], 5), round(gg[1], 5), r['supplier'], r['value'], r['date'], r['buyer'], r['title'], r['url'], r['src'], r['pc'], r['via'], r['desc']])
    out = {'status': 'ok', 'source': 'Contracts Finder + Find a Tender (OCDS award notices)', 'source_url': 'https://www.contractsfinder.service.gov.uk/',
           'licence': 'Open Government Licence v3.0', 'days': CONTRACT_DAYS, 'generated': NOW.isoformat(timespec='seconds'), 'awards_seen': len(rows), 'no_location': nopc,
           'outside_london': nonlon, 'london_awards': len(out_rows), 'london_without_value': novalue, 'rows': out_rows,
           'cols': ['lon', 'lat', 'supplier', 'value', 'date', 'buyer', 'title', 'url', 'source', 'postcode', 'located_via', 'description']}
    write('contracts.json', out); return out

# ---------------- Property sales: HM Land Registry Price Paid Data (monthly/yearly CSV, keyless) ----------------
def build_sales():
    year = NOW.year; path = os.path.join(WORK, f'pp-{year}.csv')
    if os.path.exists(path): os.remove(path)
    download(f'https://price-paid-data.publicdata.landregistry.gov.uk/pp-{year}.csv', path)
    DAYS = 60
    recs = []; maxd = ''
    with open(path, newline='', encoding='utf-8') as f:
        for row in csv.reader(f):
            if len(row) < 16 or row[13] != 'GREATER LONDON': continue
            d = row[2][:10]
            if d > maxd: maxd = d
            recs.append(row)
    start = (dt.date.fromisoformat(maxd) - dt.timedelta(days=DAYS)).isoformat()
    recs = [r for r in recs if r[2][:10] >= start and r[15] != 'D']
    g = geocode({norm_pc(r[3]) for r in recs})
    rows, miss = [], 0
    for r in sorted(recs, key=lambda r: r[2]):
        gg = g.get(norm_pc(r[3]))
        if not gg: miss += 1; continue
        addr = ', '.join(x.title() for x in [r[8], ' '.join(x for x in [r[7], r[9]] if x), r[10]] if x)
        rows.append([round(gg[0], 5), round(gg[1], 5), int(r[1]), r[2][:10], r[4], r[5], r[6], addr, norm_pc(r[3]), r[12].title(), r[14]])
    out = {'status': 'ok', 'source': 'HM Land Registry Price Paid Data', 'source_url': 'https://www.gov.uk/government/statistical-data-sets/price-paid-data-downloads',
           'licence': 'Contains HM Land Registry data (c) Crown copyright and database right 2026. Licensed under the Open Government Licence v3.0.',
           'start': start, 'end': maxd, 'generated': NOW.isoformat(timespec='seconds'), 'count': len(rows), 'geocode_missed': miss,
           'note': 'Sales appear 2 weeks to 2 months after completion, so the latest weeks are incomplete.',
           'rows': rows, 'cols': ['lon', 'lat', 'price', 'date', 'type', 'newBuild', 'tenure', 'address', 'postcode', 'borough', 'ppdCategory']}
    write('sales.json', out); return out

# ---------------- Jobs: Nomis (keyless) + Adzuna (needs free key) ----------------
BOR = ','.join('E090000%02d' % i for i in range(1, 34))
def nomis(ds, q):
    d = http(f'https://www.nomisweb.co.uk/api/v01/dataset/{ds}.data.json?geography={BOR}&{q}', timeout=120)
    return d['obs']
def build_jobs():
    jd = nomis('NM_57_1', 'time=latest&item=1,3&measures=20100')
    cc = nomis('NM_162_1', 'time=latest&gender=0&age=0&measure=1,2&measures=20100')
    b = {}
    for o in jd:
        c = o['geography']['geogcode']; x = b.setdefault(c, {'code': c, 'name': o['geography']['description']})
        if o['item']['value'] == 1: x['jobs'] = o['obs_value']['value']; x['jobs_year'] = o['time']['value']
        else: x['density'] = o['obs_value']['value']
    month = None
    for o in cc:
        c = o['geography']['geogcode']; x = b.setdefault(c, {'code': c, 'name': o['geography']['description']}); month = o['time']['description']
        if o['measure']['value'] == 1: x['claimants'] = o['obs_value']['value']
        else: x['claim_rate'] = o['obs_value']['value']
    adz = build_adzuna(b)
    out = {'status': 'ok', 'source': 'ONS via Nomis: jobs density (workplace jobs) and claimant count', 'source_url': 'https://www.nomisweb.co.uk/',
           'licence': 'Contains public sector information licensed under the Open Government Licence v3.0', 'generated': NOW.isoformat(timespec='seconds'),
           'claimant_month': month, 'boroughs': list(b.values()), 'adzuna': adz,
           'note': 'This is where London\'s jobs are and where people are claiming, not live vacancies. Live job adverts need a free Adzuna key.'}
    write('jobs.json', out); return out

def build_adzuna(b):
    aid, akey = os.environ.get('ADZUNA_APP_ID'), os.environ.get('ADZUNA_APP_KEY')
    if not (aid and akey):
        return {'status': 'needs_key', 'note': 'Live vacancies by borough need a free Adzuna API key (developer.adzuna.com). Wired and waiting: set ADZUNA_APP_ID and ADZUNA_APP_KEY as GitHub Actions secrets.', 'url': 'https://developer.adzuna.com/signup'}
    try:
        res = {}
        for c, x in b.items():
            q = urllib.parse.urlencode({'app_id': aid, 'app_key': akey, 'results_per_page': 1, 'where': x['name'] + ', London', 'distance': 3, 'content-type': 'application/json'})
            d = http('https://api.adzuna.com/v1/api/jobs/gb/search/1?' + q)
            res[c] = {'count': d.get('count'), 'mean_salary': round(d.get('mean')) if d.get('mean') else None}
            time.sleep(0.4)
        return {'status': 'ok', 'generated': NOW.isoformat(timespec='seconds'), 'by_borough': res, 'source': 'Adzuna API'}
    except Exception as e:
        return {'status': 'down', 'error': str(e)[:200]}

# ---------------- Companies House REST (needs free key): registrations since the snapshot ----------------
def build_fresh_births(snapshot_end):
    key = os.environ.get('COMPANIES_HOUSE_API_KEY')
    if not key:
        write('births_fresh.json', {'status': 'needs_key', 'generated': NOW.isoformat(timespec='seconds'),
                                    'note': 'Registrations after the monthly snapshot (and the live stream) need a free Companies House API key (developer.company-information.service.gov.uk). Wired and waiting: set COMPANIES_HOUSE_API_KEY as a GitHub Actions secret.',
                                    'url': 'https://developer.company-information.service.gov.uk/'}); return
    try:
        auth = {'Authorization': 'Basic ' + base64.b64encode((key + ':').encode()).decode()}
        d0 = snapshot_end + dt.timedelta(days=1); items = []
        while d0 <= NOW.date():
            si = 0
            while True:
                q = urllib.parse.urlencode({'incorporated_from': d0, 'incorporated_to': d0, 'size': 5000, 'start_index': si})
                d = http('https://api.company-information.service.gov.uk/advanced-search/companies?' + q, headers=auth)
                its = d.get('items') or []; items += its
                if len(its) < 5000: break
                si += 5000
            d0 += dt.timedelta(days=1); time.sleep(0.3)
        pcs = {norm_pc((i.get('registered_office_address') or {}).get('postal_code')) for i in items}; pcs.discard(None)
        g = geocode(pcs); table, tix, rows = [], {}, []
        start = snapshot_end + dt.timedelta(days=1)
        for i in items:
            p = norm_pc((i.get('registered_office_address') or {}).get('postal_code')); gg = g.get(p) if p else None
            if not gg or gg[2] != 'London': continue
            if p not in tix: tix[p] = len(table); table.append([p, round(gg[0], 5), round(gg[1], 5), gg[3]])
            rows.append([tix[p], (dt.date.fromisoformat(i['date_of_creation']) - start).days, i['company_name'], i['company_number'], (i.get('sic_codes') or [''])[0], 'ltd'])
        write('births_fresh.json', {'status': 'ok', 'source': 'Companies House API advanced search', 'start': str(start), 'end': str(NOW.date()), 'generated': NOW.isoformat(timespec='seconds'), 'count': len(rows), 'postcodes': table, 'rows': rows})
    except Exception as e:
        write('births_fresh.json', {'status': 'down', 'error': str(e)[:200], 'generated': NOW.isoformat(timespec='seconds')})

# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--only', default='')
    only = {x for x in ap.parse_args().only.split(',') if x}
    want = lambda k: not only or k in only
    status = {}
    contracts_rows = None
    if want('contracts'):
        try: contracts_rows = fetch_contracts()
        except Exception as e: fail('contracts.json', 'Contracts Finder / Find a Tender', e)
    ch = None
    if want('births') or want('offshore') or contracts_rows:
        try:
            nn = {r['coh'] for r in contracts_rows or [] if r['coh'] and not r['pc']}
            nm = {norm_name(r['supplier']) for r in contracts_rows or [] if not r['pc']}
            ch = ch_pass(nn, nm)
        except Exception as e:
            for n in ('births.json', 'offshore.json'):
                if want(n[:-5]): fail(n, 'Companies House free company data', e)
            if contracts_rows: fail('contracts.json', 'Contracts Finder', 'Companies House lookup failed: ' + str(e))
    if ch:
        if want('births'):
            try: b = build_births(ch); build_fresh_births(ch['maxd'])
            except Exception as e: fail('births.json', 'Companies House free company data', e)
        if want('offshore'):
            try: build_offshore(ch)
            except Exception as e: fail('offshore.json', 'Companies House ROE', e)
        if contracts_rows:
            try: build_contracts(contracts_rows, ch)
            except Exception as e: fail('contracts.json', 'Contracts Finder', e)
    if want('deaths'):
        try:
            b = read_seed('births.json') if not ch else None
            start = (ch['maxd'] - dt.timedelta(days=29)) if ch else (dt.date.fromisoformat(b['start']) if b and b.get('start') else (NOW.date() - dt.timedelta(days=30)))
            build_deaths(start)
        except Exception as e: fail('deaths.json', 'The Gazette', e)
    if want('sales'):
        try: build_sales()
        except Exception as e: fail('sales.json', 'HM Land Registry', e)
    if want('jobs'):
        try: build_jobs()
        except Exception as e: fail('jobs.json', 'Nomis', e)
    # manifest
    man = {'generated': NOW.isoformat(timespec='seconds'), 'files': {}}
    for fn in sorted(os.listdir(OUT)):
        if fn.endswith('.json') and fn not in ('boroughs.json', 'country_centroids.json', 'manifest.json'):
            try:
                with open(os.path.join(OUT, fn)) as f: d = json.load(f)
                man['files'][fn] = {k: d.get(k) for k in ('status', 'generated', 'count', 'error') if k in d}
            except Exception: pass
    write('manifest.json', man)

if __name__ == '__main__': main()
