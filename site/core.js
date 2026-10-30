// SatRadar core - orbit propagation and analysis (no DOM; also runs in Node for tests).
import * as S from './vendor/satellite.esm.js';

export const R_EARTH = 6371.0; // km, mean radius (spherical approximation for distances)
const D2R = Math.PI / 180;

// Orbit class from the mean elements (rough, for colouring and filtering).
export function orbitClass(mm, ecc) {
  const period = 1440 / mm; // minutes
  if (ecc >= 0.25) return 'HEO';
  if (period < 128) return 'LEO';
  if (period > 1380 && period < 1500 && ecc < 0.05) return 'GEO';
  return 'MEO';
}

export function loadCatalog(data) {
  const f = Object.fromEntries(data.fields.map((k, i) => [k, i]));
  const sats = [];
  for (const r of data.sats) {
    const omm = {
      OBJECT_NAME: r[f.name], OBJECT_ID: r[f.cospar], EPOCH: r[f.epoch],
      MEAN_MOTION: r[f.mm], ECCENTRICITY: r[f.ecc], INCLINATION: r[f.inc],
      RA_OF_ASC_NODE: r[f.raan], ARG_OF_PERICENTER: r[f.argp], MEAN_ANOMALY: r[f.ma],
      NORAD_CAT_ID: r[f.norad], ELEMENT_SET_NO: 999, BSTAR: r[f.bstar],
      MEAN_MOTION_DOT: r[f.ndot], MEAN_MOTION_DDOT: r[f.nddot],
    };
    let satrec;
    try { satrec = S.json2satrec(omm); } catch { continue; }
    const cospar = r[f.cospar] || '';
    sats.push({
      name: r[f.name], norad: r[f.norad], cospar,
      launchKey: cospar.slice(0, 8), // "YYYY-NNN" = one launch
      launch: r[f.launch] || '', owner: r[f.owner] || '', type: r[f.type] || '',
      active: !!r[f.active], epoch: r[f.epoch],
      period: 1440 / r[f.mm], inc: r[f.inc],
      cls: orbitClass(r[f.mm], r[f.ecc]), satrec,
    });
  }
  return sats;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * D2R / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin((lon2 - lon1) * D2R / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Live state of every satellite, stored in typed arrays for speed.
export class Sky {
  constructor(sats) {
    this.sats = sats;
    const n = sats.length;
    this.eci = new Float64Array(n * 3);
    this.lat = new Float32Array(n);
    this.lon = new Float32Array(n);
    this.alt = new Float32Array(n);
    this.speed = new Float32Array(n);   // orbital (inertial) speed, km/s
    this.ground = new Float32Array(n).fill(NaN); // sub-satellite point speed, km/h
    this.ok = new Uint8Array(n);
    this.time = null;
  }

  _one(i, date, gmst) {
    const pv = S.propagate(this.sats[i].satrec, date);
    const p = pv && pv.position;
    if (!p || !Number.isFinite(p.x)) return null;
    const g = S.eciToGeodetic(p, gmst);
    return { p, v: pv.velocity, lat: S.degreesLat(g.latitude), lon: S.degreesLong(g.longitude), h: g.height };
  }

  update(date) {
    const gmst = S.gstime(date);
    for (let i = 0; i < this.sats.length; i++) {
      const s = this._one(i, date, gmst);
      if (!s || s.h < 80) { this.ok[i] = 0; continue; } // failed or decayed
      this.ok[i] = 1;
      this.eci[3 * i] = s.p.x; this.eci[3 * i + 1] = s.p.y; this.eci[3 * i + 2] = s.p.z;
      this.lat[i] = s.lat; this.lon[i] = s.lon; this.alt[i] = s.h;
      this.speed[i] = Math.hypot(s.v.x, s.v.y, s.v.z);
    }
    this.time = date;
  }

  // Ground-track speed: how fast the point below the satellite moves (GEO ~ 0 km/h).
  // Must be called after update(); propagates once more, dt seconds later.
  updateGroundSpeed(dt = 10) {
    const d2 = new Date(this.time.getTime() + dt * 1000);
    const gmst = S.gstime(d2);
    for (let i = 0; i < this.sats.length; i++) {
      if (!this.ok[i]) { this.ground[i] = NaN; continue; }
      const s = this._one(i, d2, gmst);
      this.ground[i] = s ? haversineKm(this.lat[i], this.lon[i], s.lat, s.lon) / dt * 3600 : NaN;
    }
  }

  distanceKm(i, j) {
    const e = this.eci;
    return Math.hypot(e[3 * i] - e[3 * j], e[3 * i + 1] - e[3 * j + 1], e[3 * i + 2] - e[3 * j + 2]);
  }

  // Closest pairs by 3-D distance using a spatial hash; only pairs < maxKm are found.
  closestPairs(indices, { limit = 25, maxKm = 50, skipSameLaunch = true } = {}) {
    const e = this.eci, cell = maxKm, grid = new Map();
    const key = (a, b, c) => `${a},${b},${c}`;
    for (const i of indices) {
      if (!this.ok[i]) continue;
      const k = key(Math.floor(e[3 * i] / cell), Math.floor(e[3 * i + 1] / cell), Math.floor(e[3 * i + 2] / cell));
      let arr = grid.get(k); if (!arr) grid.set(k, arr = []); arr.push(i);
    }
    const pairs = [];
    for (const [k, members] of grid) {
      const [a, b, c] = k.split(',').map(Number);
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) {
        const nb = grid.get(key(a + da, b + db, c + dc));
        if (!nb) continue;
        for (const i of members) for (const j of nb) {
          if (j <= i) continue;
          if (skipSameLaunch && this.sats[i].launchKey && this.sats[i].launchKey === this.sats[j].launchKey) continue;
          const d = this.distanceKm(i, j);
          if (d < maxKm) pairs.push([d, i, j]);
        }
      }
    }
    pairs.sort((x, y) => x[0] - y[0]);
    return pairs.slice(0, limit);
  }

  // Satellites above the observer's horizon. observer: {lat, lon} degrees, h km.
  overhead(indices, observer, minElevDeg = 10, limit = 40) {
    const gmst = S.gstime(this.time);
    const obs = { latitude: observer.lat * D2R, longitude: observer.lon * D2R, height: observer.h || 0 };
    const out = [];
    for (const i of indices) {
      if (!this.ok[i]) continue;
      // cheap pre-filter: sub-point must be within ~ the horizon footprint
      const far = haversineKm(observer.lat, observer.lon, this.lat[i], this.lon[i]);
      const footprint = R_EARTH * Math.acos(R_EARTH / (R_EARTH + this.alt[i]));
      if (far > footprint) continue;
      const p = { x: this.eci[3 * i], y: this.eci[3 * i + 1], z: this.eci[3 * i + 2] };
      const la = S.ecfToLookAngles(obs, S.eciToEcf(p, gmst));
      const el = la.elevation / D2R;
      if (el >= minElevDeg) out.push({ i, el, az: (la.azimuth / D2R + 360) % 360, range: la.rangeSat });
    }
    out.sort((a, b) => b.el - a.el);
    return out.slice(0, limit);
  }

  // Ground track (list of [lat, lon]) from -back to +ahead minutes around now.
  groundTrack(i, backMin, aheadMin, steps = 160) {
    const pts = [], t0 = this.time.getTime();
    for (let k = 0; k <= steps; k++) {
      const t = new Date(t0 + (-backMin + (backMin + aheadMin) * k / steps) * 60000);
      const s = this._one(i, t, S.gstime(t));
      if (s) pts.push([s.lat, s.lon]);
    }
    return pts;
  }
}
