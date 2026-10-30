// Approximate "what is below this point?" - country from Natural Earth outlines,
// otherwise a rough ocean/sea name from simple lat/lon boxes. Approximate by design.
let countries = null;
const SHORT = { 'United States of America': 'USA', 'United Kingdom': 'UK', 'Dem. Rep. Congo': 'DR Congo', 'Central African Rep.': 'Central African Rep.' };
let loading = null;

export function loadCountries(url = 'vendor/countries.json') {
  if (countries) return Promise.resolve(countries);
  if (!loading) {
    loading = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((c) => (countries = c))
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}

export function setCountries(c) { countries = c; } // for tests

export const countriesReady = () => !!countries;

// even-odd ray casting over all rings of a country (handles holes and multi-polygons)
function inside(c, lon, lat) {
  let isIn = false;
  for (const r of c.r) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) isIn = !isIn;
    }
  }
  return isIn;
}

export function oceanName(lat, lon) {
  if (lat < -85) return 'Antarctica';
  if (lat > 66) return 'Arctic Ocean';
  if (lat < -60) return 'Southern Ocean';
  if (lat > 30 && lat < 46 && lon > -6 && lon < 37) return 'Mediterranean Sea';
  if (lat > 17 && lat < 31 && lon > -98 && lon < -80) return 'Gulf of Mexico';
  if (lat > 9 && lat < 22 && lon > -88 && lon < -60) return 'Caribbean Sea';
  if (lon >= -70 && lon < 20) return 'Atlantic Ocean';
  if (lat > 0 && lon >= -80 && lon < -70) return 'Atlantic Ocean';
  if (lon >= 20 && lon < 100 && lat < 30) return 'Indian Ocean';
  if (lon >= 100 && lon < 147 && lat < -5) return lon < 130 ? 'Indian Ocean' : 'Pacific Ocean';
  return 'Pacific Ocean';
}

// Name of the country (or ocean) below lat/lon, in degrees.
export function regionName(lat, lon) {
  lon = ((lon + 540) % 360) - 180;
  if (countries) {
    for (const c of countries) {
      const b = c.b;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (inside(c, lon, lat)) return SHORT[c.n] || c.n;
    }
  }
  return oceanName(lat, lon);
}
