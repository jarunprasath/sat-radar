// SatRadar 3D globe - an orthographic view of the Earth drawn on a <canvas>, with satellites
// at their real altitude (so GEO satellites form a ring well outside the Earth).
// No 3D library: points are rotated and projected by hand. Drag to turn, wheel / pinch to zoom.
const D2R = Math.PI / 180;
const R_EARTH = 6371;

export class Globe {
  constructor(canvas, { onPick, onRedraw } = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.lon0 = 10; this.lat0 = 30; // view centre, degrees
    this.k = 0;                     // pixels per Earth radius (0 = choose on first draw)
    this.cx = 0; this.cy = 0; this.w = 0; this.h = 0; this.dpr = 1;
    this.onPick = onPick || (() => {});
    this.onRedraw = onRedraw || (() => {});
    this._bindEvents();
  }

  // Free area of the screen (not covered by header / panel) - the globe is centred in it.
  setFrame(w, h, free) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.cv.width !== Math.round(w * this.dpr) || this.cv.height !== Math.round(h * this.dpr)) {
      this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(h * this.dpr);
      this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    }
    this.w = w; this.h = h;
    this.cx = (free.left + free.right) / 2;
    this.cy = (free.top + free.bottom) / 2;
    this.fit = Math.max(40, Math.min(free.right - free.left, free.bottom - free.top) / 2);
    if (!this.k) this.k = this.fit * 0.8;
  }

  minK() { return this.fit / 7.2; } // zoomed out far enough to see the whole GEO ring
  maxK() { return this.fit * 60; }

  // Look at lat/lon; optional angular radius (degrees) that should fill the view.
  centerOn(lat, lon, spanDeg) {
    this.lat0 = Math.max(-89, Math.min(89, lat));
    this.lon0 = lon;
    if (spanDeg) this.k = Math.max(this.minK(), Math.min(this.maxK(), this.fit * 0.8 / Math.sin(Math.min(80, spanDeg) * D2R)));
  }

  // lat/lon in degrees, r in Earth radii -> [screenX, screenY, visible]
  project(lat, lon, r = 1) {
    const p = lat * D2R, l = (lon - this.lon0) * D2R, p0 = this.lat0 * D2R;
    const cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l);
    const x = r * cp * Math.sin(l);
    const y = r * (Math.cos(p0) * sp - Math.sin(p0) * cp * cl);
    const z = r * (Math.sin(p0) * sp + Math.cos(p0) * cp * cl);
    // hidden only when behind the Earth: on the far side AND inside the Earth's disc
    const vis = z > 0 || x * x + y * y > 1;
    return [this.cx + this.k * x, this.cy - this.k * y, vis];
  }

  // screen point -> {lat, lon} on the Earth's surface, or null if off the globe
  unproject(sx, sy) {
    const x = (sx - this.cx) / this.k, y = (this.cy - sy) / this.k;
    const q = x * x + y * y;
    if (q > 1) return null;
    const z = Math.sqrt(1 - q), p0 = this.lat0 * D2R;
    const px = Math.cos(p0) * z - Math.sin(p0) * y;
    const pz = Math.sin(p0) * z + Math.cos(p0) * y;
    const lon = this.lon0 + Math.atan2(x, px) / D2R;
    return { lat: Math.asin(Math.max(-1, Math.min(1, pz))) / D2R, lon: ((lon + 540) % 360) - 180 };
  }

  // scene: {countries, points:[{lat,lon,alt,col}], track:[[lat,lon]], ticks, observer, radiusKm,
  //         selected:{lat,lon,alt,name}, pair:{lat,lon,alt}}
  draw(scene) {
    const c = this.ctx, k = this.k;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    // atmosphere glow + ocean
    const g = c.createRadialGradient(this.cx, this.cy, k * 0.98, this.cx, this.cy, k * 1.12);
    g.addColorStop(0, '#38bdf855'); g.addColorStop(1, '#38bdf800');
    c.fillStyle = g; c.beginPath(); c.arc(this.cx, this.cy, k * 1.12, 0, 6.2832); c.fill();
    c.fillStyle = '#0a1626'; c.beginPath(); c.arc(this.cx, this.cy, k, 0, 6.2832); c.fill();
    c.strokeStyle = '#1c2a3d'; c.lineWidth = 1; c.stroke();

    // graticule every 30 degrees
    c.strokeStyle = '#15233a'; c.lineWidth = 0.8;
    for (let lon = -180; lon < 180; lon += 30) this._line(Array.from({ length: 61 }, (_, i) => [-90 + i * 3, lon]));
    for (let lat = -60; lat <= 60; lat += 30) this._line(Array.from({ length: 121 }, (_, i) => [lat, -180 + i * 3]));

    // coastlines / borders (Natural Earth outlines); thin out points when zoomed out
    if (scene.countries) {
      c.strokeStyle = '#3d5a7a'; c.lineWidth = 0.9;
      const step = k < 250 ? 6 : k < 600 ? 4 : 2; // flat array: 2 numbers per point
      c.beginPath();
      for (const ctry of scene.countries) {
        for (const r of ctry.r) {
          let pen = false;
          for (let i = 0; i < r.length; i += step) {
            const [x, y, v] = this.project(r[i + 1], r[i], 1);
            if (!v) { pen = false; continue; }
            if (pen) c.lineTo(x, y); else c.moveTo(x, y);
            pen = true;
          }
        }
      }
      c.stroke();
    }

    // observer + radius circle on the surface
    if (scene.observer) {
      const o = scene.observer;
      if (scene.radiusKm) {
        const a = scene.radiusKm / R_EARTH; // angular radius, rad
        const pts = [];
        for (let i = 0; i <= 90; i++) {
          const b = i / 90 * 2 * Math.PI;
          const la = Math.asin(Math.sin(o.lat * D2R) * Math.cos(a) + Math.cos(o.lat * D2R) * Math.sin(a) * Math.cos(b));
          const lo = o.lon * D2R + Math.atan2(Math.sin(b) * Math.sin(a) * Math.cos(o.lat * D2R), Math.cos(a) - Math.sin(o.lat * D2R) * Math.sin(la));
          pts.push([la / D2R, lo / D2R]);
        }
        c.strokeStyle = '#f87171'; c.lineWidth = 1.5; c.setLineDash([4, 4]);
        this._line(pts); c.setLineDash([]);
      }
      const [x, y, v] = this.project(o.lat, o.lon, 1);
      if (v) { this._dot(x, y, 5, '#fff'); c.strokeStyle = '#f87171'; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 7, 0, 6.2832); c.stroke(); }
    }

    // ground track of the selected satellite
    if (scene.track && scene.track.length) {
      c.strokeStyle = '#34d399'; c.lineWidth = 1.5; c.setLineDash([5, 4]);
      this._line(scene.track); c.setLineDash([]);
      c.font = '600 11px system-ui, sans-serif';
      for (const tk of scene.ticks || []) {
        const [x, y, v] = this.project(tk.lat, tk.lon, 1);
        if (!v) continue;
        this._dot(x, y, 3, '#34d399');
        this._label(tk.text, x + 6, y + 4);
      }
    }

    // satellites, batched per colour
    const r = k < 250 ? 1.3 : k < 900 ? 1.8 : 2.6;
    const buckets = {};
    for (const p of scene.points) {
      const [x, y, v] = this.project(p.lat, p.lon, 1 + p.alt / R_EARTH);
      if (!v || x < -5 || y < -5 || x > this.w + 5 || y > this.h + 5) continue;
      (buckets[p.col] ||= []).push(x, y);
      p.sx = x; p.sy = y; p.vis = true;
    }
    for (const [col, xy] of Object.entries(buckets)) {
      c.fillStyle = col; c.globalAlpha = 0.85; c.beginPath();
      for (let i = 0; i < xy.length; i += 2) { c.moveTo(xy[i] + r, xy[i + 1]); c.arc(xy[i], xy[i + 1], r, 0, 6.2832); }
      c.fill();
    }
    c.globalAlpha = 1;

    if (scene.selected) {
      const s = scene.selected;
      const [x, y, v] = this.project(s.lat, s.lon, 1 + s.alt / R_EARTH);
      if (scene.pair) {
        const q = scene.pair;
        const [x2, y2, v2] = this.project(q.lat, q.lon, 1 + q.alt / R_EARTH);
        if (v && v2) { c.strokeStyle = '#fbbf24'; c.lineWidth = 2; c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke(); }
        if (v2) this._ring(x2, y2, '#fbbf24');
      }
      if (v) {
        // line down to the point on the ground, which shows the altitude
        const [gx, gy, gv] = this.project(s.lat, s.lon, 1);
        if (gv) { c.strokeStyle = '#34d39988'; c.lineWidth = 1; c.beginPath(); c.moveTo(gx, gy); c.lineTo(x, y); c.stroke(); }
        this._ring(x, y, '#34d399');
        c.font = '600 12px system-ui, sans-serif';
        this._label(s.name, x + 12, y - 10);
      }
    }
  }

  _line(pts) {
    const c = this.ctx; let pen = false; c.beginPath();
    for (const [la, lo] of pts) {
      const [x, y, v] = this.project(la, lo, 1);
      if (!v) { pen = false; continue; }
      if (pen) c.lineTo(x, y); else c.moveTo(x, y);
      pen = true;
    }
    c.stroke();
  }
  _dot(x, y, r, col) { const c = this.ctx; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill(); }
  _ring(x, y, col) { const c = this.ctx; c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 8, 0, 6.2832); c.stroke(); }
  _label(t, x, y) {
    const c = this.ctx; c.fillStyle = '#e6edf5'; c.shadowColor = '#000'; c.shadowBlur = 4;
    c.fillText(t, x, y); c.shadowBlur = 0;
  }

  // ------------------------------------------------------------ interaction
  _bindEvents() {
    const cv = this.cv, ptrs = new Map();
    let moved = 0, pinch0 = 0, k0 = 0, raf = 0;
    const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.onRedraw(); }); };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) moved = 0;
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); k0 = this.k; }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0) this.k = Math.max(this.minK(), Math.min(this.maxK(), k0 * d / pinch0));
        moved = 99; redraw(); return;
      }
      moved += Math.abs(dx) + Math.abs(dy);
      // turn the globe: one Earth radius on screen ~ one radian
      const f = 1 / Math.max(this.k, this.fit * 0.5) / D2R;
      this.lon0 -= dx * f / Math.max(0.2, Math.cos(this.lat0 * D2R));
      this.lat0 = Math.max(-89, Math.min(89, this.lat0 + dy * f));
      this.lon0 = ((this.lon0 + 540) % 360) - 180;
      redraw();
    });
    const up = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size === 0 && moved < 6 && e.type === 'pointerup') {
        const rect = cv.getBoundingClientRect();
        this.onPick(e.clientX - rect.left, e.clientY - rect.top);
      }
      if (ptrs.size < 2) pinch0 = 0;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.k = Math.max(this.minK(), Math.min(this.maxK(), this.k * Math.exp(-e.deltaY * 0.0015)));
      redraw();
    }, { passive: false });
  }

  zoomBy(f) { this.k = Math.max(this.minK(), Math.min(this.maxK(), this.k * f)); }
}
