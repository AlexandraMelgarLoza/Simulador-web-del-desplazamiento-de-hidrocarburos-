'use strict';
/*
 * Motor browniano de dispersión de hidrocarburos con deriva por viento.
 * Port de utils/motor.py; integra la deriva y la difusión con Euler-Maruyama.
 *
 * En cada paso dt:   posición(t + dt) = posición(t) + DERIVA * dt + DIFUSIÓN
 *
 * 1) DERIVA POR VIENTO: el hidrocarburo se mueve en sentido opuesto a la dirección "de donde
 *    viene" indicada por SEMAR, con una fracción de la velocidad (arrastre, 3 %):
 *    v = DRAG_COEF * U. La velocidad se estima de la altura de ola (ver wavefield.js).
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
  const DRAG_COEF = 0.03;            // fracción del viento con que se mueve el hidrocarburo
  const DEFAULT_DIFFUSIVITY = 10;    // K, m²/s
  const DEFAULT_PARTICLES = 200;
  const MAX_PARTICLES = 1000;
  const MAX_DIFFUSIVITY = 1000;
  const MAX_DRAG = 0.10;
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

  /* Estado y viento en varios puntos a la hora tMs (interpolado en el tiempo, celda más cercana
     en el espacio). Igual que WaveField.sample_many.
     Con `coast` (contorno fino): es tierra solo lo que el contorno dice que es tierra, y en las
     celdas sin dato que son agua (lagunas, bahías) se usa el viento de la celda con dato más cercana. */
  function sampleMany(field, lats, lons, tMs, out, coast) {
    const n = lats.length;
    const status = out ? out.status : new Int8Array(n);
    const wu = out ? out.wu : new Float64Array(n);
    const wv = out ? out.wv : new Float64Array(n);
    const { k0, k1, w } = field.timeWeights((tMs - field.times[0]) / 3.6e6);
    const a = 1 - w, U0 = field.wu[k0], U1 = field.wu[k1], V0 = field.wv[k0], V1 = field.wv[k1];
    for (let p = 0; p < n; p++) {
      const i = rint((lats[p] - field.lat0) / field.dlat);
      const j = rint((lons[p] - field.lon0) / field.dlon);
      if (i < 0 || i >= field.nlat || j < 0 || j >= field.nlon) { status[p] = STATUS_OUT; wu[p] = NaN; wv[p] = NaN; continue; }
      let c = i * field.nlon + j;
      if (coast) {
        if (coast.isLand(lats[p], lons[p])) { status[p] = STATUS_LAND; wu[p] = NaN; wv[p] = NaN; continue; }
        c = field.fillIdx[c];
        if (c < 0) { status[p] = STATUS_OK; wu[p] = 0; wv[p] = 0; continue; }   // agua sin dato cercano: solo difusión
      }
      const u = a * U0[c] + w * U1[c], v = a * V0[c] + w * V1[c];
      if (coast) { status[p] = STATUS_OK; wu[p] = Number.isNaN(u) ? 0 : u; wv[p] = Number.isNaN(v) ? 0 : v; continue; }
      wu[p] = u; wv[p] = v;
      status[p] = (Number.isNaN(u) || Number.isNaN(v)) ? STATUS_LAND : STATUS_OK;
    }
    return { status, wu, wv };
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
    const K = o.diffusivity ?? DEFAULT_DIFFUSIVITY, drag = o.drag ?? DRAG_COEF;
    const coast = o.coast || null;   // contorno fino de costa (opcional)

    if (![startLat, startLon, durationHours, dtHours, K, drag].every(Number.isFinite)) {
      throw new SimulationError('Hay un parámetro que no es un número válido.');
    }
    if (!(n >= 1 && n <= MAX_PARTICLES)) throw new SimulationError(`El número de partículas debe estar entre 1 y ${MAX_PARTICLES}.`);
    if (!(K >= 0 && K <= MAX_DIFFUSIVITY)) throw new SimulationError(`La difusión K debe estar entre 0 y ${MAX_DIFFUSIVITY} m²/s.`);
    if (!(drag >= 0 && drag <= MAX_DRAG)) throw new SimulationError(`El arrastre del viento debe estar entre 0 y ${MAX_DRAG * 100} %.`);
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
    const wu = new Float64Array(n).fill(s0.wu[0]), wv = new Float64Array(n).fill(s0.wv[0]);
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
      for (let q = 0; q < m; q++) dx[q] = drag * wu[idx[q]] * dtS + rng.normal(sigma);
      for (let q = 0; q < m; q++) dy[q] = drag * wv[idx[q]] * dtS + rng.normal(sigma);
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
        if (smp.status[q] === STATUS_OK) { wu[p] = smp.wu[q]; wv[p] = smp.wv[q]; }
      }
      frames.lat.push(lat.slice()); frames.lon.push(lon.slice()); frames.status.push(status.slice());
    }

    // Resumen por instante: centro de la mancha (promedio de todas las partículas) y conteos
    const nf = frames.lat.length;
    const center = [], stranded = [], lost = [], active = [];
    for (let f = 0; f < nf; f++) {
      let sa = 0, so = 0, st = 0, lo = 0, ac = 0;
      for (let p = 0; p < n; p++) {
        sa += frames.lat[f][p]; so += frames.lon[f][p];
        const s = frames.status[f][p];
        if (s === STATUS_LAND) st++; else if (s === STATUS_OUT) lo++; else ac++;
      }
      center.push([sa / n, so / n]); stranded.push(st); lost.push(lo); active.push(ac);
    }

    return {
      startMs, dtHours, n, steps: nf - 1,
      lat: frames.lat, lon: frames.lon, status: frames.status,
      center, stranded, lost, active, notes,
      origin: { lat: startLat, lon: startLon },
      params: { diffusivity: K, dragPct: drag * 100, durationHours: hours },
    };
  }

  const api = { simulate, sampleMany, makeRng, SimulationError, STATUS_OK, STATUS_LAND, STATUS_OUT,
                DRAG_COEF, DEFAULT_DIFFUSIVITY, DEFAULT_PARTICLES, MAX_PARTICLES, MAX_DIFFUSIVITY, MAX_DRAG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Motor = api;
})(typeof window !== 'undefined' ? window : globalThis);
