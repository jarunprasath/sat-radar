# SatRadar 🛰️

A "Flightradar for satellites": a mobile-friendly web page that shows where every
active satellite is **right now**, plus a Python tool that downloads the orbital data
and prints a quick analysis.

**Live page:** https://jarunprasath.github.io/sat-radar/ (after GitHub Pages is enabled – see below)

## What it shows

| Tab | What it means |
|---|---|
| **Map** | Every active satellite as a dot, coloured by orbit (LEO / MEO / GEO / HEO). Positions are recomputed in your browser every 2 s. Tap a dot for details, the country/ocean it is over now, and its path for the next orbit with UTC times (e.g. `21:28 Italy › 21:29 Austria`), also labelled on the map every 10 min. |
| **Closest** | Pairs of satellites closest to each other in space right now (straight-line distance, < 50 km), refreshed every 10 s. Option to hide pairs from the same launch (Starlink batches etc.). |
| **Slowest** | Speed of the point on Earth directly below each satellite. Geostationary satellites barely move ("parked"); higher orbits drift slowly. |
| **Oldest / Newest** | By launch date (from the CelesTrak SATCAT). "Oldest" also includes the oldest payloads still in orbit, most of which are long dead (marked *inactive*). |
| **Above me** | Satellites more than 10° above your horizon, using your phone's location (stays in the browser). |
| **Search** | By name or NORAD catalogue number. |

Country names come with their flag emoji (🇩🇪 🇮🇹 🇮🇳 …). Windows desktop browsers show two letters (e.g. "DE") instead of flags; phones and Macs show flags.

**Visitor counter:** optional, via [GoatCounter](https://www.goatcounter.com) (no cookies). Set your site code in
[`site/config.js`](site/config.js) and enable *"Allow adding visitor counts on your website"* in GoatCounter's settings.
Empty code = counter off. If the service is blocked or down, the count is simply hidden.

Filters: All, LEO, MEO, GEO, HEO, Starlink, No Starlink, Stations.

## How it works

```
CelesTrak (GP elements, SATCAT)
        │  every 6 h, GitHub Actions
        ▼
satradar.py build ──► site/data/sats.json  (orbital elements + launch dates)
                  └─► site/data/report.json (Python snapshot analysis)
        │
        ▼  GitHub Pages
site/ (index.html + app.js + core.js)  ──►  your phone propagates all orbits with SGP4 (satellite.js)
```

* Orbital data: [CelesTrak](https://celestrak.org) GP data in the OMM **CSV** format (not TLE –
  objects with 6-digit catalogue numbers are no longer available as TLEs).
* Propagation: SGP4 – [`satellite.js`](https://github.com/shashwatak/satellite-js) in the browser,
  [`sgp4`](https://pypi.org/project/sgp4/) in Python. `npm test` checks that both agree.
* Map: [Leaflet](https://leafletjs.com) with © OpenStreetMap contributors tiles.
* Country names + flags: Natural Earth 1:50m outlines (public domain), ISO codes via `i18n-iso-countries` (MIT), via [world-atlas](https://github.com/topojson/world-atlas),
  simplified to ~0.1° – border crossings and small islands are approximate; oceans/seas use rough boxes.

## One-time setup (GitHub Pages)

1. Repository **Settings → Pages → Build and deployment → Source: "GitHub Actions"**.
2. **Actions** tab → *Build and deploy SatRadar* → **Run workflow** (or just push a commit).
3. When the run is green, open `https://jarunprasath.github.io/sat-radar/` on your phone.
   Tip: browser menu → *Add to Home screen* to open it like an app.

## Run locally

```bash
pip install -r requirements.txt
npm install && npm run build          # bundles satellite.js + Leaflet into site/vendor
python satradar.py build              # downloads data (if older than 2 h) + writes site/data
python satradar.py report --top 10    # terminal report: closest pairs, slowest, oldest, newest
npm test                              # JS vs Python propagation check
python -m http.server -d site 8000    # open http://localhost:8000
```

## Accuracy and limits (please read)

* GP/SGP4 positions are typically accurate to roughly a few km for well-tracked LEO objects
  and degrade with element age – distances are **indicative only, not conjunction / collision
  assessments**.
* The map shows the CelesTrak *active* group (operational payloads) plus the oldest on-orbit
  payloads. Debris and rocket bodies are not included.
* Altitudes in the Python report use a spherical Earth; the web page uses geodetic altitude,
  so they can differ by ~10–20 km.

## Being a good CelesTrak citizen

CelesTrak is a free, donation-funded service with a strict
[usage policy](https://celestrak.org/usage-policy.php). `satradar.py`:
downloads GP data at most once per 2 h and SATCAT at most once per ~20 h, makes one attempt
per file with no retries, and stops downloading on any non-200 response (falling back to the
cached data). Please keep it that way if you change the schedule.

## Licence

MIT – see [LICENSE](LICENSE). Bundled at build time: satellite.js (MIT), Leaflet (BSD-2-Clause).
