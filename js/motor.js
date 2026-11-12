'use strict';
/*
 * Motor browniano de dispersión de hidrocarburos con deriva por oleaje.
 * Port de utils/motor.py; integra la deriva y la difusión con Euler-Maruyama.
 *
 * En cada paso dt:   posición(t + dt) = posición(t) + DERIVA * dt + DIFUSIÓN
 *
 * 1) DERIVA POR OLEAJE (deriva de Stokes): el hidrocarburo se mueve en la dirección de
 *    propagación de la ola (opuesta a dirolavto, que indica de dónde viene), con velocidad
 *    v = factor · Us,  Us = 2π³Hs²/(gT³) con T ≈ 3.86·sqrt(Hs)  →  Us ≈ 0.11·sqrt(Hs) m/s
 *    (detalle en wavefield.js). El factor (1.0 por defecto) permite calibrar la deriva.
 *    No se usa el viento.
 * 2) DIFUSIÓN BROWNIANA: paso aleatorio normal por eje, sigma = sqrt(2 K dt)
 *    (relación de Einstein Var(x) = 2 K t). K = 10 m²/s por defecto (valor de NOAA GNOME).
 * 3) No se modela la corriente marina.
 * 4) VARAMIENTO: una partícula que entra a una celda sin dato (tierra) se detiene y queda
 *    "varada". Si sale del dominio del archivo, también se detiene.
 *
 * Integración de Euler explícita. Metros a grados: dlat = dy / 111320,
 * dlon = dx / (111320 cos(lat)).
 */
(function (root) {
  const W = (typeof module !== 'undefined' && module.exports) ? require('./wavefield.js') : root.SemarData;
  const { rint } = W;

  const STATUS_OK = 0, STATUS_LAND = 1, STATUS_OUT = 2;
  const DEFAULT_WAVE_FACTOR = 1.0;   // multiplica la deriva de Stokes estimada
  const DEFAULT_DIFFUSIVITY = 10;    // K, m²/s
  const DEFAULT_PARTICLES = 200;
  const MAX_PARTICLES = 1000;
  const MAX_DIFFUSIVITY = 1000;
  const MAX_WAVE_FACTOR = 10;
  const M_PER_DEG = 111320;

  class SimulationError extends Error {}

  /* Generador pseudoaleatorio con semilla (mulberry32) + normal por el método polar. */
  function makeRng(seed) {
    let a = (seed === null || seed === undefined ? Math.floor(Math.random() * 4294967296) : seed) >>> 0;
    const uniform = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    return {
      normal(sigma) {
        if (sigma === 0) return 0;
        if (spare !== null) { const s = spare; spare = null; return s * sigma; }
        let x, y, r;
        do { x = 2 * uniform() - 1; y = 2 * uniform() - 1; r = x * x + y * y; } while (r >= 1 || r === 0);
        const m = Math.sqrt(-2 * Math.log(r) / r);
        spare = y * m;
        return x * m * sigma;
      },
    };
  }

  /* Estado y deriva por oleaje (su, sv en m/s, factor 1) en varios puntos a la hora tMs
     (interpolada en el tiempo, celda más cercana en el espacio). Igual que WaveField.sample_many.
     Con `coast` (contorno fino): es tierra solo lo que el contorno dice que es tierra, y en las
     celdas sin dato que son agua (lagunas, bahías) se usa el oleaje de la celda con dato más cercana. */
  function sampleMany(field, lats, lons, tMs, out, coast) {
    const n = lats.length;
    const status = out ? out.status : new Int8Array(n);
    const su = out ? out.su : new Float64Array(n);
    const sv = out ? out.sv : new Float64Array(n);
    const { k0, k1, w } = field.timeWeights((tMs - field.times[0]) / 3.6e6);
    const a = 1 - w, U0 = field.su[k0], U1 = field.su[k1], V0 = field.sv[k0], V1 = field.sv[k1];
    for (let p = 0; p < n; p++) {
      const i = rint((lats[p] - field.lat0) / field.dlat);
      const j = rint((lons[p] - field.lon0) / field.dlon);
      if (i < 0 || i >= field.nlat || j < 0 || j >= field.nlon) { status[p] = STATUS_OUT; su[p] = NaN; sv[p] = NaN; continue; }
      let c = i * field.nlon + j;
      if (coast) {
        if (coast.isLand(lats[p], lons[p])) { status[p] = STATUS_LAND; su[p] = NaN; sv[p] = NaN; continue; }
        c = field.fillIdx[c];
        if (c < 0) { status[p] = STATUS_OK; su[p] = 0; sv[p] = 0; continue; }   // agua sin dato cercano: solo difusión
      }
      const u = a * U0[c] + w * U1[c], v = a * V0[c] + w * V1[c];
      if (coast) { status[p] = STATUS_OK; su[p] = Number.isNaN(u) ? 0 : u; sv[p] = Number.isNaN(v) ? 0 : v; continue; }
      su[p] = u; sv[p] = v;
      status[p] = (Number.isNaN(u) || Number.isNaN(v)) ? STATUS_LAND : STATUS_OK;
    }
    return { status, su, sv };
  }

  /* Envolvente convexa de puntos [x, y] (cadena monótona). Ordena `pts` en su lugar. */
  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  /* Área (km²) y ancho máximo (km) de la envolvente convexa de las partículas EN EL AGUA
     (estado 0). Se proyecta a un plano local en km alrededor del centro (equirectangular,
     suficiente para manchas de decenas de km). Ancho máximo = mayor distancia entre dos vértices. */
  function slickGeometry(lats, lons, status) {
    const sel = [];
    for (let p = 0; p < lats.length; p++) if (status[p] === STATUS_OK) sel.push(p);
    if (sel.length < 2) return { area: 0, width: 0 };
    let la0 = 0, lo0 = 0;
    for (const p of sel) { la0 += lats[p]; lo0 += lons[p]; }
    la0 /= sel.length; lo0 /= sel.length;
    const kx = M_PER_DEG / 1000 * Math.cos(la0 * Math.PI / 180), ky = M_PER_DEG / 1000;
    const h = convexHull(sel.map((p) => [(lons[p] - lo0) * kx, (lats[p] - la0) * ky]));
    let area = 0, width = 0;
    for (let i = 0; i < h.length; i++) {
      const a = h[i], b = h[(i + 1) % h.length];
      if (h.length >= 3) area += a[0] * b[1] - b[0] * a[1];
      for (let j = i + 1; j < h.length; j++) width = Math.max(width, Math.hypot(h[j][0] - a[0], h[j][1] - a[1]));
    }
    return { area: Math.abs(area) / 2, width };
  }

  const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const g = (x) => String(+x.toFixed(2));   // equivalente a :g

  /**
   * Simula n partículas liberadas en un punto. Devuelve, por cada instante, la latitud, la
   * longitud y el estado de cada partícula (0 = a la deriva, 1 = varada, 2 = fuera del dominio).
   */
  function simulate(field, startLat, startLon, startMs, opts) {
    const o = opts || {};
    const durationHours = o.durationHours ?? 120, dtHours = o.dtHours ?? 1;
    let n = Math.trunc(o.n ?? DEFAULT_PARTICLES);
    const K = o.diffusivity ?? DEFAULT_DIFFUSIVITY, factor = o.waveFactor ?? DEFAULT_WAVE_FACTOR;
    const coast = o.coast || null;   // contorno fino de costa (opcional)

    if (![startLat, startLon, durationHours, dtHours, K, factor].every(Number.isFinite)) {
      throw new SimulationError('Hay un parámetro que no es un número válido.');
    }
    if (!(n >= 1 && n <= MAX_PARTICLES)) throw new SimulationError(`El número de partículas debe estar entre 1 y ${MAX_PARTICLES}.`);
    if (!(K >= 0 && K <= MAX_DIFFUSIVITY)) throw new SimulationError(`La difusión K debe estar entre 0 y ${MAX_DIFFUSIVITY} m²/s.`);
    if (!(factor >= 0 && factor <= MAX_WAVE_FACTOR)) throw new SimulationError(`El factor de deriva por oleaje debe estar entre 0 y ${MAX_WAVE_FACTOR}.`);
    if (dtHours <= 0 || durationHours <= 0) throw new SimulationError('La duración y el paso de tiempo deben ser positivos.');

    const [w0, w1] = field.window;
    if (!(startMs >= w0 && startMs <= w1)) {
      throw new SimulationError(`La hora de inicio debe estar dentro del pronóstico (${stamp(w0)} a ${stamp(w1)}).`);
    }

    const s0 = sampleMany(field, [startLat], [startLon], startMs, null, coast);
    if (s0.status[0] === STATUS_OUT) {
      const b = field.bounds();
      throw new SimulationError(`El punto está fuera del dominio del archivo (${b.latMin} a ${+b.latMax.toFixed(4)} °N, ${Math.abs(+b.lonMax.toFixed(4))} a ${Math.abs(b.lonMin)} °O).`);
    }
    if (s0.status[0] === STATUS_LAND) throw new SimulationError(coast ? 'El punto inicial cae en tierra firme. Colócalo en el agua.' : 'El punto inicial cae en tierra (celda sin dato en el archivo de SEMAR).');

    const notes = [];
    const remainingH = (w1 - startMs) / 3.6e6;
    const hours = Math.min(durationHours, remainingH);
    if (hours < durationHours - 1e-9) {
      notes.push(`Duración recortada a ${g(hours)} h: el pronóstico de SEMAR termina el ${stamp(w1)}.`);
    }
    const steps = Math.floor(hours / dtHours + 1e-9);
    if (steps < 1) throw new SimulationError('Después de esa hora el pronóstico no cubre ni un paso de tiempo.');

    const rng = makeRng(o.seed);
    const lat = new Float64Array(n).fill(startLat), lon = new Float64Array(n).fill(startLon);
    const status = new Int8Array(n).fill(STATUS_OK);
    const su = new Float64Array(n).fill(s0.su[0]), sv = new Float64Array(n).fill(s0.sv[0]);
    const dtS = dtHours * 3600, sigma = Math.sqrt(2 * K * dtS);

    const frames = { lat: [lat.slice()], lon: [lon.slice()], status: [status.slice()] };
    let t = startMs;
    const idx = new Int32Array(n);
    for (let s = 0; s < steps; s++) {
      let m = 0;
      for (let p = 0; p < n; p++) if (status[p] === STATUS_OK) idx[m++] = p;
      if (m === 0) {
        notes.push(`La simulación se detuvo a las ${g((t - startMs) / 3.6e6)} h: todas las partículas llegaron a costa o salieron del dominio.`);
        break;
      }
      const subLat = new Float64Array(m), subLon = new Float64Array(m);
      const dx = new Float64Array(m), dy = new Float64Array(m);
      for (let q = 0; q < m; q++) dx[q] = factor * su[idx[q]] * dtS + rng.normal(sigma);
      for (let q = 0; q < m; q++) dy[q] = factor * sv[idx[q]] * dtS + rng.normal(sigma);
      const beached = new Uint8Array(m);
      for (let q = 0; q < m; q++) {
        const p = idx[q], la = lat[p], lo = lon[p];
        const nla = la + dy[q] / M_PER_DEG;
        const nlo = lo + dx[q] / (M_PER_DEG * Math.cos(la * Math.PI / 180));
        // Con costa fina: si el paso termina en tierra (o cruza una franja de tierra), la partícula
        // queda varada en la orilla, es decir, en su última posición en el agua.
        if (coast && (coast.isLand(nla, nlo) || coast.isLand((la + nla) / 2, (lo + nlo) / 2))) {
          beached[q] = 1; subLat[q] = la; subLon[q] = lo;
          continue;
        }
        lat[p] = nla; lon[p] = nlo;
        subLat[q] = nla; subLon[q] = nlo;
      }
      t += dtHours * 3.6e6;
      const smp = sampleMany(field, subLat, subLon, t, null, coast);
      for (let q = 0; q < m; q++) {
        const p = idx[q];
        if (beached[q]) { status[p] = STATUS_LAND; continue; }
        status[p] = smp.status[q];
        if (smp.status[q] === STATUS_OK) { su[p] = smp.su[q]; sv[p] = smp.sv[q]; }
      }
      frames.lat.push(lat.slice()); frames.lon.push(lon.slice()); frames.status.push(status.slice());
    }

    // Resumen por instante: centro de la mancha (promedio de todas las partículas), conteos,
    // y área y ancho de la envolvente de las partículas en el agua
    const nf = frames.lat.length;
    const center = [], stranded = [], lost = [], active = [], area = [], width = [];
    for (let f = 0; f < nf; f++) {
      let sa = 0, so = 0, st = 0, lo = 0, ac = 0;
      for (let p = 0; p < n; p++) {
        sa += frames.lat[f][p]; so += frames.lon[f][p];
        const s = frames.status[f][p];
        if (s === STATUS_LAND) st++; else if (s === STATUS_OUT) lo++; else ac++;
      }
      center.push([sa / n, so / n]); stranded.push(st); lost.push(lo); active.push(ac);
      const geo = slickGeometry(frames.lat[f], frames.lon[f], frames.status[f]);
      area.push(geo.area); width.push(geo.width);
    }

    return {
      startMs, dtHours, n, steps: nf - 1,
      lat: frames.lat, lon: frames.lon, status: frames.status,
      center, stranded, lost, active, area, width, notes,
      origin: { lat: startLat, lon: startLon },
      params: { diffusivity: K, waveFactor: factor, durationHours: hours },
    };
  }

  const api = { simulate, sampleMany, makeRng, convexHull, slickGeometry, SimulationError, STATUS_OK, STATUS_LAND, STATUS_OUT,
                DEFAULT_WAVE_FACTOR, DEFAULT_DIFFUSIVITY, DEFAULT_PARTICLES, MAX_PARTICLES, MAX_DIFFUSIVITY,
                MAX_WAVE_FACTOR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Motor = api;
})(typeof window !== 'undefined' ? window : globalThis);
