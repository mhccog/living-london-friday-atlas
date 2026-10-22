# Living London

**Live site: https://mhccog.github.io/living-london/**

A cinematic, explorable 3D map of London running on live public data, fetched straight from the browser:

- **Santander Cycles docks** — TfL Unified API `/BikePoint` (columns: height = bikes docked now, colour = e-bike share or fullness)
- **Live line status + route geometry** — TfL `/Line/Mode/.../Status` and `/Line/{id}/Route/Sequence/all` (tube, Elizabeth line, DLR, Overground)
- **Live arrivals** — TfL `/StopPoint/{id}/Arrivals` (click any station)
- **Air quality** — London Air (Imperial College ERG) hourly monitoring index

Hover and click everything, hit **✦ Where should I go right now?** for a live-data-picked adventure, or **◎ Ambient** for a slow orbit. Auto-refreshes every 60 s. No numbers are invented: if a feed fails, the page says so.

Built with MapLibre GL JS, deck.gl and OpenFreeMap tiles (© OpenMapTiles © OpenStreetMap contributors).
Powered by TfL Open Data. Contains OS data © Crown copyright and database rights. Air quality data © London Air / Imperial College London.
