// Basic checks of site/core.js against the Python analysis (run: npm test after a build).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { loadCatalog, Sky } from '../site/core.js';

const data = JSON.parse(readFileSync('site/data/sats.json', 'utf8'));
const rep = JSON.parse(readFileSync('site/data/report.json', 'utf8'));
let t = performance.now();
const sats = loadCatalog(data);
console.log(`loaded ${sats.length} sats in ${(performance.now() - t).toFixed(0)} ms`);
const sky = new Sky(sats);
const when = new Date(rep.time);
t = performance.now(); sky.update(when); console.log(`propagate all: ${(performance.now() - t).toFixed(0)} ms`);
t = performance.now(); sky.updateGroundSpeed(); console.log(`ground speed: ${(performance.now() - t).toFixed(0)} ms`);
const all = sats.map((_, i) => i);
t = performance.now(); const pairs = sky.closestPairs(all, { skipSameLaunch: false }); console.log(`pairs: ${(performance.now() - t).toFixed(0)} ms`);

// Compare with the Python (sgp4 C++/numpy) results for the same instant
const py0 = rep.closest_pairs[0];
const [d, i, j] = pairs[0];
console.log('JS closest', d.toFixed(2), sats[i].name, sats[j].name, '| PY', py0.km, py0.a.name, py0.b.name);
assert.ok(Math.abs(d - py0.km) < 0.5);
const slowPy = rep.slowest_over_ground[0];
const k = sats.findIndex(s => s.norad === slowPy.norad);
console.log('ground speed', slowPy.name, 'JS', sky.ground[k].toFixed(2), 'PY', slowPy.ground_kmh);
assert.ok(Math.abs(sky.ground[k] - slowPy.ground_kmh) < 5);
const n = sats.findIndex(s => s.norad === rep.newest[0].norad);
console.log('alt', sats[n].name, 'JS', sky.alt[n].toFixed(1), 'PY(spherical)', rep.newest[0].alt_km);
assert.ok(Math.abs(sky.alt[n] - rep.newest[0].alt_km) < 30); // geodetic vs spherical altitude
const ov = sky.overhead(all, { lat: 49.87, lon: 8.65, h: 0.15 });
console.log('overhead Darmstadt:', ov.length, ov.slice(0, 3).map(o => `${sats[o.i].name} el ${o.el.toFixed(1)}`));
const tr = sky.groundTrack(n, 45, 45); assert.ok(tr.length > 100);
// region lookup (country outlines are built by `npm run build`)
const geo = await import('../site/geo.js');
geo.setCountries(JSON.parse(readFileSync('site/vendor/countries.json', 'utf8')));
assert.equal(geo.regionName(49.87, 8.65), 'Germany 🇩🇪');
assert.equal(geo.regionName(41.9, 12.5), 'Italy 🇮🇹');
assert.equal(geo.regionName(40.4, -3.7), 'Spain 🇪🇸');
assert.equal(geo.regionName(0, -30), 'Atlantic Ocean');
assert.equal(geo.regionName(0, 520), 'Pacific Ocean'); // longitude wrap (520 = 160)
console.log('OK');
