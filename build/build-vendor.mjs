// Copies Leaflet, bundles satellite.js and builds the country outlines into site/vendor
// (run by `npm run build`).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import iso from 'i18n-iso-countries';

mkdirSync('site/vendor/leaflet', { recursive: true });
cpSync('node_modules/leaflet/dist/leaflet.js', 'site/vendor/leaflet/leaflet.js');
cpSync('node_modules/leaflet/dist/leaflet.css', 'site/vendor/leaflet/leaflet.css');
cpSync('node_modules/leaflet/dist/images', 'site/vendor/leaflet/images', { recursive: true });

await build({
  entryPoints: ['build/sat-entry.js'], bundle: true, format: 'esm', minify: true,
  target: ['es2020'], outfile: 'site/vendor/satellite.esm.js', logLevel: 'info',
});

// Country outlines + ISO codes (Natural Earth 1:50m via world-atlas, public domain) rounded to 0.1°
// (~10 km) - plenty for "which country is it over?", and ~200 kB gzipped.
const topo = JSON.parse(readFileSync('node_modules/world-atlas/countries-50m.json', 'utf8'));
const geo = feature(topo, topo.objects.countries);
const countries = [];
for (const f of geo.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const rings = [];
  let b = [180, 90, -180, -90];
  for (const poly of polys) for (const ring of poly) {
    const flat = []; let px, py;
    for (const [x, y] of ring) {
      const X = Math.round(x * 10) / 10, Y = Math.round(y * 10) / 10;
      if (X === px && Y === py) continue;
      px = X; py = Y; flat.push(X, Y);
      b = [Math.min(b[0], X), Math.min(b[1], Y), Math.max(b[2], X), Math.max(b[3], Y)];
    }
    if (flat.length >= 6) rings.push(flat);
  }
  // ISO alpha-2 code for the flag emoji (Kosovo has no ISO numeric id; XK is its common code)
  const a2 = f.id ? iso.numericToAlpha2(f.id) : (f.properties.name === 'Kosovo' ? 'XK' : '');
  if (rings.length) countries.push({ n: f.properties.name, f: a2 || '', b, r: rings });
}
writeFileSync('site/vendor/countries.json', JSON.stringify(countries));
console.log(`  site/vendor/countries.json  ${countries.length} countries`);
