// SatRadar UI - Leaflet map + canvas layer + bottom-sheet lists.
import { loadCatalog, Sky } from './core.js';
import { loadCountries, regionName, countriesReady, getCountries } from './geo.js';
import { Globe } from './globe.js';
import { GOATCOUNTER_CODE } from './config.js';

const L = window.L;
const $ = (id) => document.getElementById(id);
const COLORS = {
  LEO: '#38bdf8', MEO: '#a78bfa', GEO: '#fbbf24', HEO: '#f472b6', old: '#94a3b8', deb: '#ef4444',
};
const RADII = [100, 200, 500, 1000, 2000]; // km, "Above me" range options (0 = whole sky)
const colorOf = (s) => (s.deb ? COLORS.deb : s.active ? COLORS[s.cls] : COLORS.old);
// Small per-browser memory (last location, radius, view). Never required - private mode etc. just forget.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('satradar.' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('satradar.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const STATION_RE = /\b(ISS|TIANGONG|CSS|TIANHE|WENTIAN|MENGTIAN)\b/i;

const state = {
  sats: [], sky: null, data: null, report: null,
  filter: 'all', visible: [], tab: 'close',
  selected: -1, pair: null, track: [], path: [], ticks: [],
  observer: null, skipSameLaunch: true, query: '',
  lastGround: 0, lastPairs: 0, pairs: [], visitors: '',
  view: '2d', radius: 200, near: [], picking: false, locMsg: '',
  placeQ: '', placeHits: null, latQ: '', lonQ: '',
};
{
  const r = store.get('radius'); if (r === 0 || RADII.includes(r)) state.radius = r;
  const o = store.get('observer');
  if (o && Number.isFinite(o.lat) && Number.isFinite(o.lon)) state.observer = { lat: o.lat, lon: o.lon, h: 0, label: String(o.label || 'Saved location') };
}

// ---------------------------------------------------------------- map setup
const map = L.map('map', {
  center: [25, 10], zoom: 2, minZoom: 1, maxZoom: 9, worldCopyJump: true,
  zoomControl: false, attributionControl: true, preferCanvas: true,
});
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 9, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · orbits: <a href="https://celestrak.org">CelesTrak</a>',
}).addTo(map);
L.control.zoom({ position: 'topleft' }).addTo(map);

const canvas = document.createElement('canvas');
canvas.className = 'sat-canvas';
map.getContainer().appendChild(canvas);
const ctx = canvas.getContext('2d');
let dpr = 1;

function resizeCanvas() {
  const s = map.getSize();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = s.x * dpr; canvas.height = s.y * dpr;
  canvas.style.width = s.x + 'px'; canvas.style.height = s.y + 'px';
  draw();
}

// Bring a longitude next to the map centre, so points show on the visible world copy.
function wrapLon(lon, centerLon) {
  return lon + 360 * Math.round((centerLon - lon) / 360);
}

// Satellites drawn right now: in "Above me" with a location set, only those near the observer.
function shownIndices() {
  if (aboveMode()) return state.near.map((o) => o.i);
  return state.visible;
}
const aboveMode = () => state.tab === 'over' && !!state.observer;

function draw() {
  if (state.view === '3d') return drawGlobe();
  const sky = state.sky;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!sky || !sky.time) return;
  const c = map.getCenter().lng;
  const z = map.getZoom();
  const r = z <= 2 ? 1.3 : z <= 4 ? 1.8 : 2.6;
  const size = map.getSize();
  // batch per colour - much faster than one path per point
  const buckets = {};
  for (const i of shownIndices()) {
    if (!sky.ok[i]) continue;
    const s = state.sats[i];
    const p = map.latLngToContainerPoint([sky.lat[i], wrapLon(sky.lon[i], c)]);
    if (p.x < -5 || p.y < -5 || p.x > size.x + 5 || p.y > size.y + 5) continue;
    (buckets[colorOf(s)] ||= []).push(p);
  }
  for (const [col, pts] of Object.entries(buckets)) {
    ctx.fillStyle = col; ctx.globalAlpha = 0.85; ctx.beginPath();
    for (const p of pts) { ctx.moveTo(p.x + r, p.y); ctx.arc(p.x, p.y, r, 0, 6.2832); }
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ground track of the selected satellite (split where it crosses the date line)
  if (state.track.length) {
    ctx.strokeStyle = '#34d399'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath();
    let prev = null;
    for (const [la, lo] of state.track) {
      const w = wrapLon(lo, c);
      const p = map.latLngToContainerPoint([la, w]);
      if (prev && Math.abs(w - prev) < 180) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      prev = w;
    }
    ctx.stroke(); ctx.setLineDash([]);
    // time + place labels along the future track
    ctx.font = '600 11px system-ui, sans-serif';
    for (const tk of state.ticks) {
      const p = map.latLngToContainerPoint([tk.lat, wrapLon(tk.lon, c)]);
      ctx.fillStyle = '#34d399'; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#e6edf5'; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
      ctx.fillText(`${hhmm(tk.t)} ${tk.name}`, p.x + 6, p.y + 4); ctx.shadowBlur = 0;
    }
  }
  // line between a selected pair
  if (state.pair) {
    const [a, b] = state.pair;
    const pa = map.latLngToContainerPoint([sky.lat[a], wrapLon(sky.lon[a], c)]);
    const pb = map.latLngToContainerPoint([sky.lat[b], wrapLon(sky.lon[b], c)]);
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ring(pb, '#fbbf24');
  }
  if (state.selected >= 0 && sky.ok[state.selected]) {
    const i = state.selected;
    const p = map.latLngToContainerPoint([sky.lat[i], wrapLon(sky.lon[i], c)]);
    ring(p, '#34d399');
    ctx.font = '600 12px system-ui, sans-serif'; ctx.fillStyle = '#e6edf5';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(state.sats[i].name, p.x + 12, p.y - 10); ctx.shadowBlur = 0;
  }
  if (state.observer) {
    const p = map.latLngToContainerPoint([state.observer.lat, wrapLon(state.observer.lon, c)]);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 6.2832); ctx.fill();
    ring(p, '#f87171');
  }
}

function ring(p, col) {
  ctx.strokeStyle = col; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 6.2832); ctx.stroke();
}

map.on('move zoom resize', draw);
map.on('resize', resizeCanvas);

// Tap on the map: pick the nearest satellite within 22 px.
map.on('click', (ev) => {
  if (state.picking) return setObserver(ev.latlng.lat, ev.latlng.lng, null, 'pick');
  const sky = state.sky; if (!sky) return;
  const c = map.getCenter().lng;
  let best = -1, bestD = 22 * 22;
  for (const i of shownIndices()) {
    if (!sky.ok[i]) continue;
    const p = map.latLngToContainerPoint([sky.lat[i], wrapLon(sky.lon[i], c)]);
    const d = (p.x - ev.containerPoint.x) ** 2 + (p.y - ev.containerPoint.y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best >= 0) select(best, false); else clearSelection();
});

// ---------------------------------------------------------------- helpers
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
const fmt = (n, d = 0) => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–';
const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function applyFilter() {
  const f = state.filter;
  state.visible = [];
  state.sats.forEach((s, i) => {
    let ok = !s.deb; // debris only appears with the two debris filters
    if (f === 'debris') ok = s.deb;
    else if (f === 'alldeb') ok = true;
    else if (['LEO', 'MEO', 'GEO', 'HEO'].includes(f)) ok = ok && s.cls === f;
    else if (f === 'starlink') ok = ok && /STARLINK/i.test(s.name);
    else if (f === 'nostarlink') ok = ok && !/STARLINK/i.test(s.name);
    else if (f === 'stations') ok = ok && STATION_RE.test(s.name);
    if (ok) state.visible.push(i);
  });
  state.lastPairs = 0;
}

function select(i, fly = true, pair = null) {
  state.selected = i; state.pair = pair;
  const s = state.sats[i], sky = state.sky;
  const half = Math.min(s.period / 2, 100);
  state.track = sky.groundTrack(i, half, half);
  state.trackAt = Date.now(); // re-computed every minute while selected (see tick)
  computePath();
  if (!countriesReady()) {
    loadCountries().then(() => { computePath(); renderCard(); draw(); }).catch(() => {});
  }
  if (fly && sky.ok[i]) focusOn(sky.lat[i], sky.lon[i]);
  if (!countriesReady() && state.view === '3d') loadCountries().then(draw).catch(() => {});
  renderCard(); draw();
}

// Upcoming path: where the satellite will be over (country / ocean) with UTC times.
function computePath() {
  const i = state.selected; if (i < 0) return;
  const s = state.sats[i], sky = state.sky, now = sky.time.getTime();
  state.path = []; state.ticks = [];
  if (!sky.ok[i]) return;
  if (s.period > 600) { // GEO and other high orbits: the point below hardly moves
    state.path = [{ t: now, name: regionName(sky.lat[i], sky.lon[i]), lat: sky.lat[i], lon: sky.lon[i] }];
    return;
  }
  const ahead = Math.min(s.period, 120);
  const pts = sky.groundTrack(i, 0, ahead, Math.round(ahead * 3)); // one point every 20 s
  let last = null;
  for (const [la, lo, t] of pts) {
    const name = regionName(la, lo);
    if (name !== last) { state.path.push({ t, name, lat: la, lon: lo }); last = name; }
  }
  for (let k = 30; k < pts.length; k += 30) { // a map label every 10 minutes
    const [la, lo, t] = pts[k];
    state.ticks.push({ lat: la, lon: lo, t, name: regionName(la, lo) });
  }
}

function clearSelection() {
  state.selected = -1; state.pair = null; state.track = []; state.path = []; state.ticks = [];
  $('card').hidden = true; draw();
}

function renderCard() {
  const i = state.selected; if (i < 0) return;
  const s = state.sats[i], k = state.sky;
  const card = $('card'); card.hidden = false;
  const oldChips = card.querySelector('.chips');
  const scrollX = oldChips ? oldChips.scrollLeft : 0;
  card.innerHTML = `
    <h3><span style="color:${colorOf(s)}">●</span>${esc(s.name)}
      <button aria-label="Close" id="cardx">×</button></h3>
    <p class="note" style="margin:0 0 6px">NORAD ${s.norad} · ${esc(s.cospar)} · ${esc(s.owner || '?')} · launched ${esc(s.launch || '?')}${s.deb ? ' · <b style="color:var(--deb)">debris</b>' : s.active ? '' : ' · inactive'}</p>
    <p class="over">Now over ≈ <b>${esc(regionName(k.lat[i], k.lon[i]))}</b> <span class="muted">· ${new Date().toISOString().slice(11, 19)} UTC</span></p>
    <dl>
      <div><dt>Altitude</dt><dd>${fmt(k.alt[i])} km</dd></div>
      <div><dt>Orbital speed</dt><dd>${fmt(k.speed[i], 2)} km/s</dd></div>
      <div><dt>Over ground</dt><dd>${fmt(k.ground[i])} km/h</dd></div>
      <div><dt>Lat / Lon</dt><dd>${fmt(k.lat[i], 1)}, ${fmt(k.lon[i], 1)}</dd></div>
      <div><dt>Period</dt><dd>${fmt(s.period, 1)} min</dd></div>
      <div><dt>Orbit</dt><dd>${s.cls} · ${fmt(s.inc, 1)}°</dd></div>
    </dl>
    ${pathHtml(s)}
    ${state.pair ? `<p class="note" style="margin:6px 0 0">Distance to ${esc(state.sats[state.pair[1]].name)}: <b>${fmt(k.distanceKm(state.pair[0], state.pair[1]), 2)} km</b></p>` : ''}`;
  $('cardx').onclick = clearSelection;
  const chips = card.querySelector('.chips'); if (chips) chips.scrollLeft = scrollX;
}

function pathHtml(s) {
  if (!state.path.length) return '';
  if (s.period > 600) {
    return `<p class="note" style="margin:6px 0 0">Stays over ≈ ${esc(state.path[0].name)} — ${s.cls === 'GEO' ? 'geostationary, it hardly moves over the ground' : 'very slow over the ground'}.</p>`;
  }
  const chips = state.path.map((p, k) =>
    `<button class="chip" data-lat="${p.lat}" data-lon="${p.lon}"><b>${k ? hhmm(p.t) : 'now'}</b> ${esc(p.name)}</button>`).join('<span class="arr">›</span>');
  return `<div class="path"><div class="path-h">Next ${fmt(Math.min(s.period, 120))} min · times in UTC · approximate</div><div class="chips">${chips}</div></div>`;
}

$('card').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  focusOn(Number(c.dataset.lat), Number(c.dataset.lon));
});

function row(i, val, sub, attrs = '') {
  const s = state.sats[i];
  return `<div class="row" data-i="${i}" ${attrs}><div class="name">${esc(s.name)}${s.deb ? '<span class="tag deb">debris</span>' : s.active ? '' : '<span class="tag">inactive</span>'}</div>
    <div class="val">${val}</div><div class="sub">${sub}</div></div>`;
}

// ---------------------------------------------------------------- tabs
function renderPanel() {
  const sky = state.sky; if (!sky) return;
  const P = $('panel');
  const t = state.tab;
  const vis = state.visible.filter((i) => sky.ok[i]);
  let html = '';

  if (t === 'close') {
    html += `<div class="field"><label class="chk"><input type="checkbox" id="samel" ${state.skipSameLaunch ? 'checked' : ''}> hide pairs from the same launch</label></div>`;
    html += `<p class="note">Straight-line distance in space right now, updated every 10 s. Approximate (SGP4 ≈ km-level error) — not a collision warning.</p>`;
    if (!state.pairs.length) html += '<p class="muted">No pairs closer than 50 km in this filter.</p>';
    for (const [d, a, b] of state.pairs) {
      html += `<div class="row" data-pair="${a},${b}"><div class="name">${esc(state.sats[a].name)} ↔ ${esc(state.sats[b].name)}</div>
        <div class="val">${fmt(d, 2)} km</div><div class="sub">alt ${fmt(sky.alt[a])} km · ${state.sats[a].cls}</div></div>`;
    }
  } else if (t === 'slow') {
    html += `<p class="note">Speed of the point on Earth directly below the satellite. Geostationary satellites (≈35,786 km up) look almost parked; higher orbits move slowly across the sky.</p>`;
    const list = vis.filter((i) => Number.isFinite(sky.ground[i])).sort((a, b) => sky.ground[a] - sky.ground[b]).slice(0, 60);
    for (const i of list) {
      const parked = sky.ground[i] < 50 ? '<span class="tag">parked</span>' : '';
      html += row(i, `${fmt(sky.ground[i])} km/h`, `alt ${fmt(sky.alt[i])} km · ${state.sats[i].cls} · orbital ${fmt(sky.speed[i], 2)} km/s ${parked}`);
    }
  } else if (t === 'oldest' || t === 'newest') {
    const dated = vis.filter((i) => state.sats[i].launch);
    dated.sort((a, b) => state.sats[a].launch.localeCompare(state.sats[b].launch));
    if (t === 'newest') dated.reverse();
    html += t === 'oldest'
      ? `<p class="note">By launch date. Includes the oldest payloads still in orbit (most are long dead and marked inactive) plus all active satellites.</p>`
      : `<p class="note">Most recently launched objects in the current data.</p>`;
    if (!dated.length) html += '<p class="muted">No launch dates loaded yet (SATCAT not downloaded).</p>';
    for (const i of dated.slice(0, 60)) {
      const s = state.sats[i];
      html += row(i, esc(s.launch), `${esc(s.owner || '?')} · ${s.cls} · alt ${fmt(sky.alt[i])} km · NORAD ${s.norad}`);
    }
  } else if (t === 'over') {
    html += overHtml();
  } else if (t === 'find') {
    const q = state.query.trim().toUpperCase();
    html += `<div class="field"><input type="search" id="q" placeholder="Name or NORAD id, e.g. ISS, METOP, 25544" value="${esc(state.query)}" autocomplete="off"></div>`;
    if (q) {
      const hits = state.sats.map((s, i) => i).filter((i) => state.sats[i].name.toUpperCase().includes(q) || String(state.sats[i].norad) === q).slice(0, 60);
      if (!hits.length) html += '<p class="muted">No match.</p>';
      for (const i of hits) html += row(i, sky.ok[i] ? `${fmt(sky.alt[i])} km` : '–', `${state.sats[i].cls} · launched ${esc(state.sats[i].launch || '?')} · NORAD ${state.sats[i].norad}`);
    }
  }
  const keepFocus = document.activeElement && document.activeElement.id === 'q';
  const caret = keepFocus ? document.activeElement.selectionStart : 0;
  P.innerHTML = html;
  if (keepFocus) { const q = $('q'); q.focus(); q.setSelectionRange(caret, caret); }
}

// ---------------------------------------------------------------- "Above me"
const dir8 = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];

function overHtml() {
  const sky = state.sky, o = state.observer;
  if (!o) {
    let h = `<p class="note">Choose your location to see what is passing over you. It stays in this browser and is not sent to this site.</p>
      <button class="btn" id="locate">📍 Use my location</button>
      ${state.locMsg ? `<p class="warn">${esc(state.locMsg)}</p>` : ''}
      <div class="sec">…or search a place</div>
      <div class="field"><input type="text" id="place" placeholder="Town or place, e.g. Darmstadt, Madurai" value="${esc(state.placeQ)}" autocomplete="off" enterkeyhint="search">
        <button class="btn2" id="placeGo">Find</button></div>`;
    if (state.placeHits === 'busy') h += '<p class="muted">Searching…</p>';
    else if (typeof state.placeHits === 'string') h += `<p class="warn">${esc(state.placeHits)}</p>`;
    else if (state.placeHits) {
      if (!state.placeHits.length) h += '<p class="muted">No place found - try another spelling, or enter latitude / longitude below.</p>';
      state.placeHits.forEach((p, k) => { h += `<button class="hit" data-hit="${k}">${esc(p.label)}<div class="muted" style="font-size:11px">${fmt(p.lat, 3)}, ${fmt(p.lon, 3)}</div></button>`; });
      h += '<p class="note" style="font-size:10px">Place search: Nominatim · © OpenStreetMap contributors</p>';
    }
    h += `<div class="sec">…or enter coordinates (decimal degrees)</div>
      <div class="field"><input type="text" class="ll" id="olat" inputmode="decimal" placeholder="Latitude  49.87" value="${esc(state.latQ)}">
        <input type="text" class="ll" id="olon" inputmode="decimal" placeholder="Longitude  8.65" value="${esc(state.lonQ)}">
        <button class="btn2" id="llGo">Set</button></div>
      <div class="sec">…or tap the map</div>
      <button class="btn2 ${state.picking ? 'on' : ''}" id="pick">${state.picking ? 'Now tap your location on the map / globe…' : '🗺 Pick on map'}</button>`;
    return h;
  }
  const opts = RADII.map((r) => `<option value="${r}" ${state.radius === r ? 'selected' : ''}>${fmt(r)} km</option>`).join('')
    + `<option value="0" ${state.radius === 0 ? 'selected' : ''}>whole sky (≥10° up)</option>`;
  let h = `<div class="obs">📍<div class="lbl"><b>${esc(o.label)}</b><div class="muted" style="font-size:11px">${fmt(o.lat, 3)}, ${fmt(o.lon, 3)}</div></div>
      <button class="btn2" id="obsChange">Change</button></div>
    <div class="field"><label class="chk" style="font-size:13px">Show within <select id="radius">${opts}</select> of me</label></div>`;
  const n = state.near.length;
  h += state.radius
    ? `<p class="note">${fmt(n)} object${n === 1 ? '' : 's'} whose ground point is within ${fmt(state.radius)} km of you (current filter). Only these are drawn on the map. Most are too faint to see by eye; geostationary satellites stay over the equator, so pick “whole sky” to see them.</p>`
    : `<p class="note">${fmt(n)} object${n === 1 ? '' : 's'} more than 10° above your horizon (current filter). Only these are drawn on the map. Most are too faint to see by eye.</p>`;
  for (const v of state.near.slice(0, 100)) {
    h += row(v.i, `${fmt(v.el)}° ${dir8(v.az)}`,
      `${v.dist !== undefined ? `${fmt(v.dist)} km away · ` : ''}alt ${fmt(sky.alt[v.i])} km · elevation ${fmt(v.el, 1)}°, azimuth ${fmt(v.az)}° · range ${fmt(v.range)} km`);
  }
  if (n > 100) h += `<p class="muted">…and ${fmt(n - 100)} more on the map. Choose a smaller range or a filter to narrow it down.</p>`;
  return h;
}

function computeNear() {
  const sky = state.sky;
  if (!aboveMode() || !sky || !sky.time) { state.near = []; return; }
  state.near = state.radius
    ? sky.nearby(state.visible, state.observer, state.radius)
    : sky.overhead(state.visible, state.observer, 10, 0);
}

// Show the observer's area: the radius circle on the 2D map, or the globe turned towards it.
let circle = null;
function updateObserverView(zoom = false) {
  if (circle) { circle.remove(); circle = null; }
  if (!aboveMode()) return;
  const o = state.observer;
  const km = state.radius || 2500; // whole sky: frame roughly the LEO horizon
  if (state.radius && state.view === '2d') {
    circle = L.circle([o.lat, o.lon], { radius: km * 1000, color: '#f87171', weight: 1.5, dashArray: '4 4', fill: true, fillOpacity: 0.05, interactive: false }).addTo(map);
  }
  if (!zoom) return;
  if (state.view === '3d') globe.centerOn(o.lat, o.lon, Math.max(3, km / 111 * 1.6));
  else map.fitBounds(L.latLng(o.lat, o.lon).toBounds(km * 2000 * 1.2), { maxZoom: 9 });
}

function setObserver(lat, lon, label, src) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return false;
  lon = ((lon + 540) % 360) - 180;
  state.picking = false; setPickCursor();
  state.locMsg = ''; state.placeHits = null;
  const obs = { lat, lon, h: 0, label: label || (countriesReady() ? regionName(lat, lon) : 'Chosen point'), src };
  state.observer = obs;
  store.set('observer', { lat, lon, label: obs.label });
  if (!label && !countriesReady()) { // name the spot once the country outlines have loaded
    loadCountries().then(() => {
      if (state.observer !== obs) return;
      obs.label = regionName(lat, lon); store.set('observer', { lat, lon, label: obs.label }); renderPanel();
    }).catch(() => {});
  }
  if (state.tab !== 'over') selectTab('over');
  computeNear(); updateObserverView(true); renderPanel(); draw(); updateStatus();
  return true;
}

function setPickCursor() {
  $('map').classList.toggle('picking', state.picking);
  $('globe').classList.toggle('picking', state.picking);
}

async function findPlace() {
  const q = state.placeQ.trim(); if (!q) return;
  state.placeHits = 'busy'; renderPanel();
  try {
    // Nominatim (OpenStreetMap) search: one request per button press, as its usage policy asks.
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    state.placeHits = (Array.isArray(j) ? j : []).map((p) => ({
      lat: Number(p.lat), lon: Number(p.lon),
      label: String(p.display_name || q).split(',').slice(0, 3).join(',').trim(),
    })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  } catch (e) {
    state.placeHits = `Place search is not reachable right now (${e.message}). Enter latitude / longitude below instead.`;
  }
  renderPanel();
}

$('panel').addEventListener('click', (e) => {
  const id = e.target.id;
  if (id === 'locate') return locate();
  if (id === 'placeGo') return findPlace();
  if (id === 'llGo') {
    if (!setObserver(state.latQ.replace(',', '.'), state.lonQ.replace(',', '.'), null, 'manual')) {
      state.locMsg = 'Please enter latitude (−90 … 90) and longitude (−180 … 180) as decimal numbers, e.g. 49.87 and 8.65.';
      renderPanel();
    }
    return;
  }
  if (id === 'pick') {
    state.picking = !state.picking; setPickCursor(); renderPanel();
    if (state.picking && $('sheet').dataset.state === 'full') $('sheet').dataset.state = 'half';
    return;
  }
  if (id === 'obsChange') {
    state.observer = null; state.near = []; updateObserverView(); renderPanel(); draw(); updateStatus(); return;
  }
  const hit = e.target.closest('.hit');
  if (hit && Array.isArray(state.placeHits)) {
    const p = state.placeHits[Number(hit.dataset.hit)];
    if (p) setObserver(p.lat, p.lon, p.label, 'place');
    return;
  }
  const r = e.target.closest('.row'); if (!r) return;
  if (r.dataset.pair) {
    const [a, b] = r.dataset.pair.split(',').map(Number);
    select(a, true, [a, b]);
  } else select(Number(r.dataset.i));
});
$('panel').addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'q') { state.query = e.target.value; renderPanel(); }
  else if (id === 'place') state.placeQ = e.target.value;
  else if (id === 'olat') state.latQ = e.target.value;
  else if (id === 'olon') state.lonQ = e.target.value;
});
$('panel').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'place') { e.preventDefault(); findPlace(); }
  if (e.target.id === 'olat' || e.target.id === 'olon') { e.preventDefault(); $('llGo').click(); }
});
$('panel').addEventListener('change', (e) => {
  if (e.target.id === 'samel') { state.skipSameLaunch = e.target.checked; state.lastPairs = 0; tick(true); }
  if (e.target.id === 'radius') {
    state.radius = Number(e.target.value); store.set('radius', state.radius);
    computeNear(); updateObserverView(true); renderPanel(); draw(); updateStatus();
  }
});

function selectTab(tab) {
  const was = aboveMode();
  state.tab = tab;
  for (const x of $('tabs').children) x.classList.toggle('on', x.dataset.tab === tab);
  if ($('sheet').dataset.state === 'min') $('sheet').dataset.state = 'half';
  if (tab !== 'over' && state.picking) { state.picking = false; setPickCursor(); }
  computeNear();
  if (aboveMode() !== was) updateObserverView(aboveMode());
  renderPanel(); draw(); updateStatus();
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  selectTab(b.dataset.tab);
});
// Header search button - also reachable on desktop, where the tab row may be cut off.
$('searchBtn').addEventListener('click', () => {
  selectTab('find');
  const q = $('q'); if (q) q.focus();
});
$('handle').addEventListener('click', () => {
  const s = $('sheet');
  s.dataset.state = { half: 'full', full: 'min', min: 'half' }[s.dataset.state];
});
$('filter').addEventListener('change', (e) => {
  state.filter = e.target.value; applyFilter(); computeNear(); tick(true);
});

function locate() {
  const fail = (msg) => { state.locMsg = msg; renderPanel(); };
  if (!navigator.geolocation) return fail('Location is not available in this browser - search a place or enter coordinates below.');
  state.locMsg = 'Asking the browser for your location…'; renderPanel();
  navigator.geolocation.getCurrentPosition(
    (p) => { setObserver(p.coords.latitude, p.coords.longitude, 'My location', 'gps'); },
    (err) => fail(err.code === 1
      ? 'Location access is blocked for this page. Search a place or enter coordinates below instead.'
      : `Could not get your location (${err.message}). Search a place or enter coordinates below instead.`),
    { enableHighAccuracy: false, timeout: 15000 },
  );
}

// ---------------------------------------------------------------- 3D globe
const globe = new Globe($('globe'), {
  onRedraw: () => drawGlobe(),
  onPick: (x, y) => {
    if (state.picking) { const g = globe.unproject(x, y); if (g) setObserver(g.lat, g.lon, null, 'pick'); return; }
    let best = -1, bestD = 22 * 22;
    for (const p of globePoints) {
      if (!p.vis) continue;
      const d = (p.sx - x) ** 2 + (p.sy - y) ** 2;
      if (d < bestD) { bestD = d; best = p.i; }
    }
    if (best >= 0) select(best, false); else clearSelection();
  },
});
let globePoints = [];

// Part of the screen not covered by the header and the panel - the globe is centred there.
function freeArea() {
  const w = window.innerWidth, h = window.innerHeight;
  const top = $('legend').getBoundingClientRect().top - 4;
  const sh = $('sheet').getBoundingClientRect();
  if (w >= 900) return { left: sh.right, right: w, top, bottom: h };
  return { left: 0, right: w, top, bottom: Math.max(top + 120, sh.top) };
}

function drawGlobe() {
  const sky = state.sky; if (!sky || !sky.time) return;
  globe.setFrame(window.innerWidth, window.innerHeight, freeArea());
  globePoints = [];
  for (const i of shownIndices()) {
    if (!sky.ok[i]) continue;
    globePoints.push({ i, lat: sky.lat[i], lon: sky.lon[i], alt: sky.alt[i], col: colorOf(state.sats[i]) });
  }
  const sel = state.selected >= 0 && sky.ok[state.selected]
    ? { lat: sky.lat[state.selected], lon: sky.lon[state.selected], alt: sky.alt[state.selected], name: state.sats[state.selected].name } : null;
  const pb = state.pair && state.pair[1];
  globe.draw({
    countries: getCountries(), points: globePoints, track: state.track,
    ticks: state.ticks.map((t) => ({ lat: t.lat, lon: t.lon, text: `${hhmm(t.t)} ${t.name}` })),
    observer: state.observer, radiusKm: aboveMode() ? state.radius : 0, selected: sel,
    pair: sel && state.pair ? { lat: sky.lat[pb], lon: sky.lon[pb], alt: sky.alt[pb] } : null,
  });
}

function setView(v) {
  state.view = v; store.set('view', v);
  const is3d = v === '3d';
  $('globe').hidden = !is3d; $('gctl').hidden = !is3d;
  $('map').classList.toggle('off', is3d);
  $('viewBtn').textContent = is3d ? '2D' : '3D';
  $('viewBtn').title = is3d ? 'Back to the flat map' : '3D globe';
  $('viewBtn').classList.toggle('on', is3d);
  if (is3d) {
    const c = map.getCenter();
    globe.centerOn(c.lat, c.lng);
    if (!countriesReady()) loadCountries().then(draw).catch(() => {});
  } else {
    map.invalidateSize();
    map.setView([globe.lat0, globe.lon0], map.getZoom(), { animate: false });
  }
  updateObserverView(false);
  draw();
}
$('viewBtn').addEventListener('click', () => setView(state.view === '3d' ? '2d' : '3d'));
$('gzin').addEventListener('click', () => { globe.zoomBy(1.4); draw(); });
$('gzout').addEventListener('click', () => { globe.zoomBy(1 / 1.4); draw(); });
window.addEventListener('resize', () => { if (state.view === '3d') draw(); });
new ResizeObserver(() => { if (state.view === '3d') draw(); }).observe($('sheet'));

// Move the view to a point (2D map or 3D globe).
function focusOn(lat, lon) {
  if (state.view === '3d') { globe.centerOn(lat, lon); draw(); return; }
  map.flyTo([lat, wrapLon(lon, map.getCenter().lng)], Math.max(map.getZoom(), 3), { duration: 0.8 });
}

// ---------------------------------------------------------------- main loop
function ageText(iso) {
  if (!iso) return '?';
  const h = (Date.now() - new Date(iso).getTime()) / 3.6e6;
  return h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`;
}

function tick(force = false) {
  const sky = state.sky; if (!sky) return;
  if (document.hidden && !force) return;
  const now = new Date();
  sky.update(now);
  if (force || now - state.lastGround > 30000) { sky.updateGroundSpeed(); state.lastGround = now.getTime(); }
  if (force || now - state.lastPairs > 10000) {
    state.pairs = sky.closestPairs(state.visible, { limit: 40, maxKm: 50, skipSameLaunch: state.skipSameLaunch });
    state.lastPairs = now.getTime();
  }
  computeNear();
  if (state.selected >= 0) {
    renderCard();
    if (state.track.length && now - state.trackAt > 60000) select(state.selected, false, state.pair);
  }
  draw();
  const ae = document.activeElement;
  const typing = ae && $('panel').contains(ae) && /^(INPUT|SELECT)$/.test(ae.tagName);
  // lists refresh every 6 s (not every tick) so a tap on a row isn't lost to a re-render
  if (!typing && (force || now - (state.lastPanel || 0) > 6000)) { renderPanel(); state.lastPanel = now.getTime(); }
  updateStatus();
}

function updateStatus() {
  const sky = state.sky; if (!sky || !sky.time) return;
  const shown = shownIndices().reduce((n, i) => n + sky.ok[i], 0);
  $('status').textContent = `${shown.toLocaleString()} objects shown · elements ${ageText(state.data.gp_fetched)} old · data: CelesTrak`
    + (state.visitors ? ` · 👁 ${state.visitors} visitors` : '') + ' · © Arun Prasath J';
}

setInterval(() => {
  $('clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC';
}, 1000);

// ---------------------------------------------------------------- visitor counter
// Registers this visit with GoatCounter, then reads the site-wide total.
// Any failure (blocked by an ad blocker, offline, not set up yet) just hides the count.
function startVisitorCounter() {
  const code = (GOATCOUNTER_CODE || '').trim();
  if (!/^[a-z0-9-]+$/i.test(code)) return;
  const base = `https://${code}.goatcounter.com`;
  const sc = document.createElement('script');
  sc.async = true;
  sc.dataset.goatcounter = `${base}/count`;
  sc.src = 'https://gc.zgo.at/count.js';
  document.head.appendChild(sc);

  const read = async (path) => {
    const r = await fetch(`${base}/counter/${encodeURIComponent(path)}.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j || !j.count || j.count === '0') throw new Error('no count yet');
    return String(j.count);
  };
  const load = () => read('TOTAL').catch(() => read(location.pathname))
    .then((n) => { state.visitors = n; if (state.sky) tick(true); })
    .catch(() => {});
  setTimeout(load, 2500); // give count.js time to register this visit first
}

async function start() {
  try {
    const res = await fetch('data/sats.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading data/sats.json`);
    state.data = await res.json();
    state.sats = loadCatalog(state.data);
    state.sky = new Sky(state.sats);
    applyFilter();
    resizeCanvas();
    tick(true);
    if (store.get('view') === '3d') setView('3d');
    setInterval(() => tick(false), 2000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });
    if (state.data.warnings && state.data.warnings.length) console.warn('Data warnings:', state.data.warnings);
  } catch (err) {
    $('panel').innerHTML = `<p>Could not load satellite data.</p><p class="muted">${esc(err.message)}</p>
      <p class="note">If you just set this up, wait for the GitHub Action to finish its first run.</p>`;
  }
}

startVisitorCounter();
start();
