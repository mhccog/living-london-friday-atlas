# Living London (v2)

**Live site: https://mhccog.github.io/living-london/**

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

## Data sources and credits
- TfL Unified API, Annual Station Counts 2025 (crowding.data.tfl.gov.uk). Powered by TfL Open Data. Contains OS data © Crown copyright and database rights.
- Wikipedia / Wikimedia EventStreams (CC BY-SA content).
- Weather data by Open-Meteo.com (CC BY 4.0).
- Air quality: London Air, Imperial College London (ERG).
- Map: OpenFreeMap / OpenMapTiles © OpenStreetMap contributors. Greater London boundary © OpenStreetMap contributors (ODbL).
- Built with MapLibre GL JS and deck.gl.

`data/london.json` was built on 22 Oct 2026. See its `sources` field.
