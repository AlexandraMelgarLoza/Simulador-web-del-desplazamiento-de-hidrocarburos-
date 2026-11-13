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
 *
 * DERIVA POR OLEAJE (deriva de Stokes en superficie, aguas profundas)
 * El archivo trae solo la altura significante Hs (alturaolavto) y la dirección de donde viene
 * la ola (dirolavto); no trae periodo. Se estima así:
 *
 *   1) Periodo de mar desarrollado:        T ≈ PERIOD_COEF · sqrt(Hs),  PERIOD_COEF = 3.86 s/m^½
 *   2) Deriva de Stokes en la superficie (ola lineal en aguas profundas, amplitud a = Hs/2,
 *      número de onda k = 4π² / (g T²), frecuencia ω = 2π / T):
 *          Us = ω · k · a² = 2 π³ Hs² / (g T³)
 *   3) Sustituyendo T:  Us = 2 π³ / (g · 3.86³) · sqrt(Hs) ≈ 0.11 · sqrt(Hs)   [m/s, Hs en m]
 *
 * La deriva va en la dirección de PROPAGACIÓN de la ola, es decir, opuesta a dirolavto.
 * El motor la multiplica por un "factor de deriva por oleaje" (1.0 por defecto) para calibrarla.
 */
(function (root) {
  const FILL_THRESHOLD = -1e8;
  const WAVE_DIR_CONVENTION = 'from';   // dirolavto = dirección de donde VIENE la ola
  const G = 9.81;                       // gravedad, m/s²
  const PERIOD_COEF = 3.86;             // T ≈ PERIOD_COEF · sqrt(Hs)  (mar desarrollado)
  const STOKES_COEF = 2 * Math.PI ** 3 / (G * PERIOD_COEF ** 3);   // ≈ 0.1099; Us = STOKES_COEF · sqrt(Hs)
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

  /* Deriva de Stokes en superficie (m/s) para una altura significante hs (m). Ver encabezado. */
  const stokesDrift = (hs) => STOKES_COEF * Math.sqrt(Math.max(hs, 0));
  /* Periodo estimado (s) para una altura significante hs (m). */
  const wavePeriod = (hs) => PERIOD_COEF * Math.sqrt(Math.max(hs, 0));

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
      // Velocidad de deriva de Stokes (m/s, factor 1) por celda: su hacia el este, sv hacia el norte.
      // Con convención "from" la deriva va al revés de dirolavto (hacia donde se propaga la ola).
      const sign = WAVE_DIR_CONVENTION === 'from' ? -1 : 1;
      this.su = []; this.sv = [];
      for (let k = 0; k < times.length; k++) {
        const u = new Float32Array(nlat * nlon), v = new Float32Array(nlat * nlon);
        for (let c = 0; c < u.length; c++) {
          const sp = stokesDrift(hs[k][c]);                 // NaN se propaga
          const th = direction[k][c] * Math.PI / 180;
          u[c] = sign * sp * Math.sin(th);
          v[c] = sign * sp * Math.cos(th);
        }
        this.su.push(u); this.sv.push(v);
      }
      this.buildFill(4);
    }

    /*
     * Para cada celda sin dato guarda el índice de la celda CON dato más cercana (a lo más
     * `maxRadius` celdas; -1 si no hay). Sirve para dar deriva a las aguas costeras (lagunas,
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
      return { su: new Float32Array(n), sv: new Float32Array(n), hs: new Float32Array(n) };
    }
    /* Deriva por oleaje y altura de ola interpoladas a la hora th, escritas en `out` (de makeFrame). */
    interpolateInto(th, out) {
      const { k0, k1, w } = this.timeWeights(th);
      const a = 1 - w, su0 = this.su[k0], su1 = this.su[k1], sv0 = this.sv[k0], sv1 = this.sv[k1],
            h0 = this.hs[k0], h1 = this.hs[k1];
      for (let c = 0; c < out.su.length; c++) {
        out.su[c] = a * su0[c] + w * su1[c];
        out.sv[c] = a * sv0[c] + w * sv1[c];
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

  /* Lee un dirmarea.txt elegido desde la computadora (input type=file) con FileReader.
     No usa fetch, así que funciona aunque la página se abra con doble clic (file://). */
  function readSemarFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const field = parseSemarWaves(reader.result);
          field.sourceName = file.name;
          field.lastModified = file.lastModified || null;
          resolve(field);
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new SemarFormatError(`No se pudo leer el archivo ${file.name}.`));
      reader.readAsText(file);
    });
  }

  const api = { WaveField, SemarFormatError, parseSemarWaves, loadSemarWaves, readSemarFile,
                stokesDrift, wavePeriod, STOKES_COEF, PERIOD_COEF, rint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SemarData = api;
})(typeof window !== 'undefined' ? window : globalThis);
