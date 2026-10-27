# Living London (v3: Living mode + Business mode)

**Live site: https://mhccog.github.io/living-london-friday-atlas/**

A cinematic, explorable 3D map of London. Everything is fetched straight from your browser from open, keyless, CORS-enabled sources. Nothing is invented: where something is a *typical pattern* rather than a *live reading*, the page says so.

## Layers
- **The city's pulse**: every station breathes in proportion to how busy it is.
  - *Typical* (amber): TfL crowding API `/crowding/{naptan}`, typical busyness per 15 minutes for each weekday (268 Underground stations). Precomputed into `data/london.json`.
  - *Live* (cyan = quieter than usual, pink = busier): TfL `/crowding/{naptan}/Live`, fetched in a gentle sweep (about one request every 2.5 s) and compared with the typical value for the same slot.
  - Size: TfL Annual Station Counts 2025 (typical daily entries and exits) × the slot's share of the day's profile. This is a derived estimate, shown with "≈".
  - Time scrubber with play button: watch a typical day. "Now" turns the live overlay back on.
- **Where London is curious**: English Wikipedia article edits geotagged inside Greater London.
  - Live from Wikimedia EventStreams `recentchange`, with coordinates from the Wikipedia API.
  - Backfilled with the last hour of RecentChanges, plus articles near London edited in the last 24 h.
- **Weather atmosphere**: Open-Meteo current conditions for London.
  - Fog and haze from visibility and cloud cover.
  - Rain or snow particles only when it's actually falling.
  - Sky tint from the real sun position.
  - Storm risk from weather codes, CAPE and ICON lightning potential.
  - Live lightning strikes are **not** shown. Blitzortung's terms don't allow third-party use of its data, and there's no open, keyless alternative.
- Also: live TfL line status (with line routes), live arrivals (click a station), London Air hourly air-quality index, and Santander bikes (off by default).

## Business mode ("London, Inc.")
A full re-theme of the same map, switched with the LIVING / BUSINESS toggle at the top (`?mode=living` or `?mode=business` also works; your choice is remembered). Business mode reads real open data only, and says so on the page when a feed is down or needs a key. Code: `business.js`, `business.css`; data builder: `scripts/build_business.py`.

| Layer | Source | Notes |
|---|---|---|
| Company births | Companies House *Free Company Data Product* (monthly snapshot, keyless) | London registered offices, last 30 days of the snapshot, geocoded with postcodes.io |
| Company deaths | The Gazette corporate-insolvency JSON feed (keyless, geotagged) | winding-up orders, administrations, resolutions, petitions |
| Offshore London | Companies House Register of Overseas Entities (in the free snapshot) | countries only: the register has no property addresses. The building-level list (HMLR OCOD) needs a free account, **not signed up** |
| Who's hiring where | ONS via Nomis: workplace jobs and claimant count by borough (keyless) | not live vacancies. Wired for Adzuna, needs `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` |
| Government money | Contracts Finder + Find a Tender OCDS award notices (keyless) | London supplier postcodes; notice values can be framework ceilings |
| The commute, measured | TfL typical profiles + 2025 counts (`data/london.json`) + TfL live crowding | office-district live-vs-usual meter |
| Property sales towers | HM Land Registry Price Paid Data (keyless CSV) | latest 60 days available; the newest weeks are incomplete |

**Keys** (optional, all free; add as GitHub Actions repository secrets, never commit them): `COMPANIES_HOUSE_API_KEY` (registrations after the monthly snapshot), `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` (live vacancies). Until set, those parts show "needs a free key" on the page.

**Hosting**: `.github/workflows/deploy.yml` runs daily and on every push. It runs `scripts/build_business.py` (Python standard library only), assembles the site and deploys it with GitHub Pages' Actions deployment, so refreshed data is never committed back. The JSON files committed in `data/business/` are a seed: they are deployed if the refresh fails and the page marks them stale.

## Data sources and credits
- TfL Unified API, Annual Station Counts 2025 (crowding.data.tfl.gov.uk). Powered by TfL Open Data. Contains OS data © Crown copyright and database rights.
- Wikipedia / Wikimedia EventStreams (CC BY-SA content).
- Weather data by Open-Meteo.com (CC BY 4.0).
- Air quality: London Air, Imperial College London (ERG).
- Map: OpenFreeMap / OpenMapTiles © OpenStreetMap contributors. Greater London boundary © OpenStreetMap contributors (ODbL).
- Business mode: Companies House (Free Company Data Product, OGL v3), The Gazette (OGL v3), Contracts Finder and Find a Tender (OGL v3), HM Land Registry Price Paid Data (Contains HM Land Registry data © Crown copyright and database right 2026, OGL v3), ONS via Nomis (OGL v3), ONS Open Geography borough boundaries (Contains OS data © Crown copyright), postcodes.io (ONS Postcode Directory).
- Built with MapLibre GL JS and deck.gl.

`data/london.json` was built on 22 Oct 2026. See its `sources` field.

## History and ownership
Built by Friday (one of Cyrus's Grok Bots) in October 2026. Passed on to Atlas, which now runs it.
