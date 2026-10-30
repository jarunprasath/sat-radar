// Copies Leaflet and bundles satellite.js into site/vendor (run by `npm run build`).
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('site/vendor/leaflet', { recursive: true });
cpSync('node_modules/leaflet/dist/leaflet.js', 'site/vendor/leaflet/leaflet.js');
cpSync('node_modules/leaflet/dist/leaflet.css', 'site/vendor/leaflet/leaflet.css');
cpSync('node_modules/leaflet/dist/images', 'site/vendor/leaflet/images', { recursive: true });
await build({
  entryPoints: ['build/sat-entry.js'], bundle: true, format: 'esm', minify: true,
  target: ['es2020'], outfile: 'site/vendor/satellite.esm.js', logLevel: 'info',
});
