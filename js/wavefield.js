'use strict';
/*
 * Lector del archivo de SEMAR (dirmarea.txt). Port de utils/semar_reader.py.
 *
 * Formato:
 *   LON;LAT;dirolavto;alturaolavto
 *   01OCT2026 00 3          <- corrida (ddMMMaaaa HH) + horas de pronóstico
 *   -98;23.;-9.99e+08;-9.99e+08
 *   ...
 *
 * -9.99e+08 = sin dato = tierra.
 * Viento estimado a partir del oleaje de viento:  U = sqrt(Hs / PM_COEF).
 */
(function (root) {
  const FILL_THRESHOLD = -1e8;
  const WAVE_DIR_CONVENTION = 'from';   // Dirección de donde viene, como el viento
  const PM_COEF = 0.0246;               // Hs = PM_COEF * U^2 (por confirmar, ver README)
  const REQUIRED = ['lon', 'lat', 'dirolavto', 'alturaolavto'];
  const MONTHS = { JAN: 1, ENE: 1, FEB: 2, MAR: 3, APR: 4, ABR: 4, MAY: 5, JUN: 6, JUL: 7,
                   AUG: 8, AGO: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12, DIC: 12 };
  const HEADER_RE = /^(\d{1,2})([A-Za-z]{3})(\d{4})\s+(\d{1,2})\s+(\d+)\s*$/;

  class SemarFormatError extends Error {}

  /* Redondeo al entero más cercano, empates al par (igual que np.rint). */
  function rint(x) {
    const r = Math.round(x);
    return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
  }

  /* Fechas "ingenuas": se guardan como milisegundos UTC y se muestran en UTC,
     para que el huso horario del navegador no mueva las horas del archivo. */
  function readHeader(m) {
    const [, day, mon, year, hh, lead] = m;
    const monN = MONTHS[mon.toUpperCase()];
    if (!monN) throw new SemarFormatError(`mes desconocido '${mon}' en el encabezado '${m[0]}'`);
    const run = Date.UTC(+year, monN - 1, +day, +hh);
    return { run, lead: +lead };
  }

  class WaveField {
    constructor(runTime, times, lat0, lon0, dlat, dlon, nlat, nlon, direction, hs, warnings) {
      this.runTime = runTime;              // ms UTC
      this.times = times;                  // ms UTC, ordenados
      this.hours = times.map((t) => (t - times[0]) / 3.6e6);
      this.lat0 = lat0; this.lon0 = lon0; this.dlat = dlat; this.dlon = dlon;
      this.nlat = nlat; this.nlon = nlon;
      this.direction = direction;          // Float32Array[nt][nlat*nlon], NaN = tierra
      this.hs = hs;
      this.warnings = warnings;
      const sign = WAVE_DIR_CONVENTION === 'from' ? -1 : 1;
      this.wu = []; this.wv = [];
      for (let k = 0; k < times.length; k++) {
        const u = new Float32Array(nlat * nlon), v = new Float32Array(nlat * nlon);
        for (let c = 0; c < u.length; c++) {
          const sp = Math.sqrt(Math.max(hs[k][c], 0) / PM_COEF);   // NaN se propaga
          const th = direction[k][c] * Math.PI / 180;
          u[c] = sign * sp * Math.sin(th);
          v[c] = sign * sp * Math.cos(th);
        }
        this.wu.push(u); this.wv.push(v);
      }
      this.buildFill(4);
    }

    /*
     * Para cada celda sin dato guarda el índice de la celda CON dato más cercana (a lo más
     * `maxRadius` celdas; -1 si no hay). Sirve para dar viento a las aguas costeras (lagunas,
     * bahías) que la rejilla de SEMAR marca como "tierra". Las celdas con dato se apuntan a sí mismas.
     */
    buildFill(maxRadius) {
      const { nlat, nlon } = this, n = nlat * nlon;
      const valid = new Uint8Array(n).fill(1);
      for (let k = 0; k < this.times.length; k++) {
        const h = this.hs[k];
        for (let c = 0; c < n; c++) if (Number.isNaN(h[c])) valid[c] = 0;
      }
      const offs = [];
      for (let di = -maxRadius; di <= maxRadius; di++) {
        for (let dj = -maxRadius; dj <= maxRadius; dj++) {
          const d2 = di * di + dj * dj;
          if (d2 > 0 && d2 <= maxRadius * maxRadius) offs.push([d2, di, dj]);
        }
      }
      offs.sort((a, b) => a[0] - b[0]);
      this.fillIdx = new Int32Array(n).fill(-1);
      for (let i = 0; i < nlat; i++) {
        for (let j = 0; j < nlon; j++) {
          const c = i * nlon + j;
          if (valid[c]) { this.fillIdx[c] = c; continue; }
          for (const [, di, dj] of offs) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || ii >= nlat || jj < 0 || jj >= nlon) continue;
            if (valid[ii * nlon + jj]) { this.fillIdx[c] = ii * nlon + jj; break; }
          }
        }
      }
    }
    get window() { return [this.times[0], this.times[this.times.length - 1]]; }
    get stepHours() {
      const d = this.hours.slice(1).map((h, i) => h - this.hours[i]).sort((a, b) => a - b);
      return d[Math.floor(d.length / 2)];
    }
    bounds() {
      return { latMin: this.lat0, latMax: this.lat0 + this.dlat * (this.nlat - 1),
               lonMin: this.lon0, lonMax: this.lon0 + this.dlon * (this.nlon - 1) };
    }
    index(i, j) { return i * this.nlon + j; }
    /* Celda más cercana a (lat, lon); null si cae fuera de la rejilla. */
    cellAt(lat, lon) {
      const i = rint((lat - this.lat0) / this.dlat);
      const j = rint((lon - this.lon0) / this.dlon);
      return (i < 0 || i >= this.nlat || j < 0 || j >= this.nlon) ? null : { i, j };
    }
    /* Pesos de interpolación en el tiempo; th = horas desde el primer paso. (Igual que _time_weights.) */
    timeWeights(th) {
      const H = this.hours;
      th = Math.min(Math.max(th, H[0]), H[H.length - 1]);
      let lo = 0, hi = H.length;                     // searchsorted (lado izquierdo)
      while (lo < hi) { const mid = (lo + hi) >> 1; if (H[mid] < th) lo = mid + 1; else hi = mid; }
      const k1 = Math.min(Math.max(lo, 1), H.length - 1), k0 = k1 - 1;
      const den = H[k1] - H[k0];
      return { k0, k1, w: den <= 0 ? 0 : (th - H[k0]) / den };
    }
    makeFrame() {
      const n = this.nlat * this.nlon;
      return { wu: new Float32Array(n), wv: new Float32Array(n), hs: new Float32Array(n) };
    }
    /* Viento y altura de oleaje interpolados a la hora th, escritos en `out` (de makeFrame). */
    interpolateInto(th, out) {
      const { k0, k1, w } = this.timeWeights(th);
      const a = 1 - w, wu0 = this.wu[k0], wu1 = this.wu[k1], wv0 = this.wv[k0], wv1 = this.wv[k1],
            h0 = this.hs[k0], h1 = this.hs[k1];
      for (let c = 0; c < out.wu.length; c++) {
        out.wu[c] = a * wu0[c] + w * wu1[c];
        out.wv[c] = a * wv0[c] + w * wv1[c];
        out.hs[c] = a * h0[c] + w * h1[c];
      }
      return out;
    }
  }

  const round4 = (x) => Math.round(x * 1e4) / 1e4;

  function parseSemarWaves(text) {
    const lines = text.split(/\r?\n/);
    if (!lines.length || !lines[0].trim()) throw new SemarFormatError('El archivo está vacío.');
    const cols = lines[0].split(';').map((c) => c.trim().toLowerCase());
    const missing = REQUIRED.filter((c) => !cols.includes(c));
    if (missing.length) {
      throw new SemarFormatError(`Encabezado inesperado; faltan las columnas ${missing.join(', ')}.`);
    }
    const idx = REQUIRED.map((c) => cols.indexOf(c));
    const warnings = [];
    const warn = (m) => { if (warnings.length < 20) warnings.push(m); };

    const blocks = [];
    let cur = null;
    for (let n = 1; n < lines.length; n++) {
      const s = lines[n].trim();
      if (!s) continue;
      const m = HEADER_RE.exec(s);
      if (m) {
        const { run, lead } = readHeader(m);
        cur = { run, valid: run + lead * 3.6e6, rows: [] };
        blocks.push(cur);
        continue;
      }
      if (!cur) { warn(`línea ${n + 1}: dato antes de un encabezado de tiempo, se omite`); continue; }
      const p = s.split(';');
      if (p.length !== cols.length) { warn(`línea ${n + 1}: número de columnas incorrecto, se omite`); continue; }
      const lon = +p[idx[0]], lat = +p[idx[1]], d = +p[idx[2]], h = +p[idx[3]];
      if (Number.isNaN(lon + lat + d + h)) { warn(`línea ${n + 1}: valor no numérico, se omite`); continue; }
      cur.rows.push([lon, lat, d, h]);
    }

    const full = blocks.filter((b) => b.rows.length);
    if (!full.length) throw new SemarFormatError('No se encontró ningún bloque de tiempo con datos.');

    // Geometría de la rejilla a partir del bloque más completo
    const ref = full.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    const lons = [...new Set(ref.rows.map((r) => round4(r[0])))].sort((a, b) => a - b);
    const lats = [...new Set(ref.rows.map((r) => round4(r[1])))].sort((a, b) => a - b);
    if (lons.length < 2 || lats.length < 2) throw new SemarFormatError('La rejilla es demasiado pequeña.');
    const nlon = lons.length, nlat = lats.length, expected = nlon * nlat;
    if (ref.rows.length !== expected) throw new SemarFormatError('La rejilla no es regular (hay puntos repetidos o faltantes).');
    const dlon = (lons[nlon - 1] - lons[0]) / (nlon - 1);
    const dlat = (lats[nlat - 1] - lats[0]) / (nlat - 1);
    const lon0 = lons[0], lat0 = lats[0];

    const byTime = new Map();
    for (const b of full) {
      if (b.rows.length !== expected) {
        warn(`Se omitió el bloque de ${new Date(b.valid).toISOString().slice(0, 16)}: tiene ${b.rows.length} de ${expected} puntos (¿el archivo se estaba escribiendo?)`);
        continue;
      }
      const d = new Float32Array(expected).fill(NaN);
      const h = new Float32Array(expected).fill(NaN);
      for (const [lon, lat, dir, hs] of b.rows) {
        const j = Math.round((lon - lon0) / dlon), i = Math.round((lat - lat0) / dlat);
        if (i < 0 || i >= nlat || j < 0 || j >= nlon) continue;
        if (dir > FILL_THRESHOLD && hs > FILL_THRESHOLD) { d[i * nlon + j] = dir; h[i * nlon + j] = hs; }
      }
      byTime.set(b.valid, { run: b.run, d, h });
    }
    if (byTime.size < 2) throw new SemarFormatError(`El archivo solo tiene ${byTime.size} paso(s) de tiempo completo(s); se necesitan al menos 2.`);

    const times = [...byTime.keys()].sort((a, b) => a - b);
    return new WaveField(byTime.get(times[0]).run, times, lat0, lon0, dlat, dlon, nlat, nlon,
      times.map((t) => byTime.get(t).d), times.map((t) => byTime.get(t).h), warnings);
  }

  /* Descarga el TXT sin usar caché: cada refresh de la página trae la corrida vigente. */
  async function loadSemarWaves(url) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new SemarFormatError(`No se pudo descargar ${url} (código ${res.status}).`);
    const field = parseSemarWaves(await res.text());
    field.sourceName = url.split('/').pop();
    field.lastModified = res.headers.get('Last-Modified');
    return field;
  }

  const api = { WaveField, SemarFormatError, parseSemarWaves, loadSemarWaves, PM_COEF, rint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SemarData = api;
})(typeof window !== 'undefined' ? window : globalThis);
