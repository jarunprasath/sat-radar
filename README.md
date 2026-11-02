# SatRadar 🛰️

A "Flightradar for satellites": a mobile-friendly web page that shows where every
active satellite is **right now**, plus a Python tool that downloads the orbital data
and prints a quick analysis.

**Live page:** https://jarunprasath.github.io/sat-radar/ (after GitHub Pages is enabled – see below)

## What it shows

| Tab | What it means |
|---|---|
| **Map** | Every active satellite as a dot, coloured by orbit (LEO / MEO / GEO / HEO). Positions are recomputed in your browser every 2 s. Tap a dot for details, the country/ocean it is over now, and its path for the next orbit with UTC times (e.g. `21:28 Italy › 21:29 Austria`), also labelled on the map every 10 min. The **3D** button in the header switches to a 3D globe (drag to turn, wheel / pinch or +/− to zoom) where satellites sit at their real altitude; **2D** switches back. |
| **Closest** | Pairs of satellites closest to each other in space right now (straight-line distance, < 50 km), refreshed every 10 s. Option to hide pairs from the same launch (Starlink batches etc.). |
| **Slowest** | Speed of the point on Earth directly below each satellite. Geostationary satellites barely move ("parked"); higher orbits drift slowly. |
| **Oldest / Newest** | By launch date (from the CelesTrak SATCAT). "Oldest" also includes the oldest payloads still in orbit, most of which are long dead (marked *inactive*). |
| **Above me** | What is passing over you. Set your location with the browser's location, a place search, typed latitude / longitude, or by tapping the map / globe (useful when location access is blocked). Only objects whose ground point is within the chosen range (100, **200** default, 500, 1000, 2000 km) are listed **and drawn**; "whole sky" shows everything more than 10° above your horizon instead. The location stays in your browser. |
| **Search** | By name or NORAD catalogue number. Also opens from the 🔍 button in the header. |

Country names come with their flag emoji (🇩🇪 🇮🇹 🇮🇳 …). Windows desktop browsers show two letters (e.g. "DE") instead of flags; phones and Macs show flags.

**Visitor counter:** optional, via [GoatCounter](https://www.goatcounter.com) (no cookies). Set your site code in
[`site/config.js`](site/config.js) and enable *"Allow adding visitor counts on your website"* in GoatCounter's settings.
Empty code = counter off. If the service is blocked or down, the count is simply hidden.

Filters: All, LEO, MEO, GEO, HEO, Starlink, No Starlink, Stations, **Debris**, **All + debris**.
"All" and the other filters show satellites only; debris (red) appears only with the two debris filters.

**Debris:** CelesTrak publishes element sets for the major debris clouds — Fengyun 1C, Cosmos 2251,
Iridium 33 and Cosmos 1408 — and SatRadar downloads these groups. This is **not the full debris
population**: CelesTrak's public GP groups cover these clouds, not every tracked fragment or rocket body.

## How it works

```
CelesTrak (GP elements, SATCAT)
        │  every 2 h, GitHub Actions
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
* Map: [Leaflet](https://leafletjs.com) with © OpenStreetMap contributors tiles. 3D globe: plain canvas
  drawing (no 3D library), country outlines as below.
* Place search in "Above me": [Nominatim](https://nominatim.org) (© OpenStreetMap contributors),
  one request per button press, sent straight from your browser.
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
downloads GP data at most about once per 2 h, the four debris groups at most once per ~6 h and SATCAT at most once per ~20 h, makes one attempt
per file with no retries, and stops downloading on any non-200 response (falling back to the
cached data). Please keep it that way if you change the schedule.

## Licence

MIT – see [LICENSE](LICENSE). Bundled at build time: satellite.js (MIT), Leaflet (BSD-2-Clause).
