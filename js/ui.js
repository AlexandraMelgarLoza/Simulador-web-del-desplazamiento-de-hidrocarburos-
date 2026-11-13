'use strict';
/*
 * Interfaz: carga de datos, punto de derrame, simulación, reproducción por horas y lecturas.
 * Usa App (sketch.js), SemarData (wavefield.js) y Motor (motor.js).
 */

const DATA_URL = 'data/dirmarea.txt';
const COAST_URL = 'data/coast.json';
const COAST_WARN = 'No se pudo cargar el contorno de costa fino; se usa la rejilla de SEMAR (las lagunas y bahías pequeñas contarán como tierra).';
const MS_H = 3.6e6;
const pad = (n) => String(n).padStart(2, '0');

/* ===================== Formatos ===================== */
function dmsStr(v, withSeconds) {
  const a = Math.abs(v);
  if (withSeconds) {
    const t = Math.round(a * 3600);
    return `${Math.floor(t / 3600)}°${pad(Math.floor((t % 3600) / 60))}′${pad(t % 60)}″`;
  }
  const t = Math.round(a * 60);
  return `${Math.floor(t / 60)}°${pad(t % 60)}′`;
}
function labelCoord(v, hemis, step) {                     // etiquetas de la cuadrícula
  const h = v >= 0 ? hemis[0] : hemis[1];
  if (App.state.fmt === 'dms') return step >= 1 ? `${Math.abs(Math.round(v))}°${h}` : `${dmsStr(v, step < 0.05)}${h}`;
  const dec = (String(step).split('.')[1] || '').length;
  return `${Math.abs(v).toFixed(dec)}°${h}`;
}
App.fmtLat = (v, step) => labelCoord(v, ['N', 'S'], step);
App.fmtLon = (v, step) => labelCoord(v, ['E', 'O'], step);

function fmtCoord(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S', eo = lon >= 0 ? 'E' : 'O';
  if (App.state.fmt === 'dms') return `${dmsStr(lat, true)} ${ns}, ${dmsStr(lon, true)} ${eo}`;
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${eo}`;
}

/* Fechas "ingenuas": se muestran en UTC para que el huso del navegador no mueva las horas del archivo. */
function fmtDate(ms, withYear) {
  const o = { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  if (withYear) o.year = 'numeric';
  return new Date(ms).toLocaleString('es-MX', o);
}
const toInputValue = (ms) => new Date(ms).toISOString().slice(0, 16);

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/* ===================== Mensajes ===================== */
const S2 = App.state, map2 = App.map;

function setStatus(text, isError) {
  const el = $('status-text');
  el.textContent = text;
  el.style.color = isError ? 'var(--bad)' : '';
}
function setNotice(text, isError) {
  const el = $('field-notice');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('error', Boolean(isError));
}
function setWarnings(list) {
  const ul = $('warnings-list');
  ul.innerHTML = '';
  (list || []).forEach((w) => { const li = document.createElement('li'); li.textContent = w; ul.appendChild(li); });
}

/* ===================== Tiempo ===================== */
let range = { min: 0, max: 0 };    // horas (desde el inicio del pronóstico) que cubre la barra de tiempo
let lastUiHour = null;

function simOffset() { return S2.sim ? (S2.sim.startMs - S2.field.times[0]) / MS_H : 0; }

function setTimeRange(min, max) {
  range = { min, max };
  const tl = $('timeline');
  tl.min = Math.ceil(min - 1e-9); tl.max = Math.floor(max + 1e-9);
  S2.h = Math.max(min, Math.min(S2.h, max));
  const ticks = $('timeline-ticks');
  ticks.replaceChildren();
  const first = Math.ceil(min), last = Math.floor(max);
  const interval = Math.max(1, Math.ceil((last - first) / 6));
  for (let hour = first; hour <= last; hour += interval) {
    const option = document.createElement('option');
    option.value = String(hour);
    ticks.appendChild(option);
  }
  if (last >= first && (!ticks.lastChild || Number(ticks.lastChild.value) !== last)) {
    const option = document.createElement('option');
    option.value = String(last);
    ticks.appendChild(option);
  }
}

function updateTimeUI(force) {
  const f = S2.field;
  if (!f) return;
  const hour = Math.floor(S2.h + 1e-6);
  if (!force && hour === lastUiHour) return;
  lastUiHour = hour;
  $('timeline').value = hour;
  const ms = f.times[0] + hour * MS_H;
  if (S2.sim) {
    $('tl-main').textContent = `Hora +${hour - Math.round(simOffset())} h desde el derrame`;
    $('tl-sub').textContent = fmtDate(ms, true);
  } else {
    $('tl-main').textContent = `Pronóstico · hora ${hour}`;
    $('tl-sub').textContent = fmtDate(ms, true);
  }
  updateSpillStats(hour);
}

/* ===================== Gráficas de resultados ===================== */
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const e = document.createElementNS(SVGNS, tag);
  Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
  return e;
};
const charts = {};          // id del <svg> → { n, series, max, cursor, dot }
let chartsFor = null;       // simulación para la que están dibujadas

function buildChart(id, maxId, series, color, fmtMax) {
  const svg = $(id);
  svg.replaceChildren();
  charts[id] = null;
  if (!series) { $(maxId).textContent = '—'; return; }
  const n = series.length - 1;
  let max = 0;
  for (let k = 0; k <= n; k++) if (series[k] > max) max = series[k];
  max = Math.max(max, 1e-9);
  const X = (k) => (n ? k / n : 0) * 300, Y = (v) => 58 - (v / max) * 50;
  let pts = '';
  for (let k = 0; k <= n; k++) pts += `${k ? ' ' : ''}${X(k).toFixed(1)},${Y(series[k]).toFixed(1)}`;
  svg.appendChild(svgEl('path', { d: `M0,64 L${pts.replace(/ /g, ' L')} L300,64 Z`, fill: color, 'fill-opacity': '0.14' }));
  svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const cursor = svgEl('line', { x1: 0, x2: 0, y1: 0, y2: 64, stroke: '#F3F7FD', 'stroke-opacity': '0.45', 'stroke-width': '1' });
  const dot = svgEl('circle', { cx: 0, cy: 58, r: 3.5, fill: '#0D1526', stroke: color, 'stroke-width': '2' });
  svg.appendChild(cursor); svg.appendChild(dot);
  charts[id] = { n, series, Y, X, cursor, dot };
  $(maxId).textContent = fmtMax(max);
}

function placeChartCursor(k) {
  Object.keys(charts).forEach((id) => {
    const c = charts[id];
    if (!c) return;
    const x = c.X(k).toFixed(1), y = c.Y(c.series[k]).toFixed(1);
    c.cursor.setAttribute('x1', x); c.cursor.setAttribute('x2', x);
    c.dot.setAttribute('cx', x); c.dot.setAttribute('cy', y);
  });
}

let firstStrandText = '—';
function rebuildCharts(sim) {
  const fmtArea = (m) => `máx. ${m < 10 ? m.toFixed(2) : m.toFixed(0)} km²`;
  buildChart('chart-area', 'ch-area-max', sim ? sim.area : null, '#6EA8FF', fmtArea);
  buildChart('chart-stranded', 'ch-str-max', sim ? sim.stranded : null, '#FF7A7A', (m) => `máx. ${Math.round(m)} de ${sim.n}`);
  firstStrandText = '—';
  if (sim) {
    const k = sim.stranded.findIndex((v) => v > 0);
    firstStrandText = k < 0 ? 'Sin varamiento' : `+${Math.round(k * sim.dtHours)} h`;
  }
  chartsFor = sim;
}

function updateSpillStats(hour) {
  const sim = S2.sim;
  const set = (id, t) => { $(id).textContent = t; };
  if (chartsFor !== sim) rebuildCharts(sim);
  if (!sim) {
<<<<<<< Updated upstream
    ['st-hour', 'st-active', 'st-stranded', 'st-lost', 'st-center', 'st-dist'].forEach((id) => set(id, '—'));
=======
    ['st-hour', 'st-active', 'st-stranded', 'st-lost', 'st-area', 'st-width', 'st-center', 'st-dist', 'st-first'].forEach((id) => set(id, '—'));
    ['summary-dist', 'summary-stranded', 'summary-arrival'].forEach((id) => set(id, '—'));
>>>>>>> Stashed changes
    return;
  }
  const k = Math.max(0, Math.min(sim.steps, Math.round((hour - simOffset()) / sim.dtHours)));
  placeChartCursor(k);
  set('st-first', firstStrandText);
  const c = sim.center[k];
  set('st-hour', `+${Math.round(k * sim.dtHours)} h`);
  set('st-active', `${sim.active[k]} de ${sim.n}`);
  set('st-stranded', String(sim.stranded[k]));
  set('st-lost', String(sim.lost[k]));
  set('st-center', fmtCoord(c[0], c[1]));
  const distance = distKm(sim.origin.lat, sim.origin.lon, c[0], c[1]);
  set('st-dist', `${distance.toFixed(1)} km`);
  set('summary-dist', `${distance.toFixed(1)} km`);
  set('summary-stranded', `${sim.stranded[k]} / ${sim.n} · ${(sim.stranded[k] / sim.n * 100).toFixed(1)}%`);
  set('summary-arrival', firstStrandText);
}

function play() {
  if (!S2.field || S2.playing) return;
  if (S2.h >= range.max - 1e-6) S2.h = range.min;
  S2.playing = true;
  $('btn-play').textContent = '❚❚';
  $('btn-play').setAttribute('aria-label', 'Pausar');
  App.refreshLoop();
}
function pause() {
  if (!S2.playing) return;
  S2.playing = false;
  $('btn-play').textContent = '▶';
  $('btn-play').setAttribute('aria-label', 'Reproducir');
  App.refreshLoop();
}

App.onFrame = (dt) => {
  if (S2.playing) {
    S2.h += dt * Number($('speed').value);
    if (S2.h >= range.max) { S2.h = range.max; pause(); }
  }
  updateTimeUI(false);
};

$('btn-play').addEventListener('click', () => (S2.playing ? pause() : play()));
$('timeline').addEventListener('input', (e) => { pause(); S2.h = Number(e.target.value); updateTimeUI(true); App.redraw(); });

document.addEventListener('keydown', (e) => {
  const target = e.target;
  const editing = target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName));
  if (editing || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    S2.playing ? pause() : play();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    pause();
    S2.h = Math.max(range.min, Math.min(range.max, S2.h + (e.key === 'ArrowRight' ? 1 : -1)));
    updateTimeUI(true);
    App.redraw();
  }
});

/* En pantallas pequeñas, los paneles se convierten en drawers sobre el mapa. */
function closeDrawers() {
  document.querySelectorAll('.panel.is-open').forEach((panel) => panel.classList.remove('is-open'));
  $('drawer-backdrop').hidden = true;
  $('btn-open-settings').setAttribute('aria-expanded', 'false');
  $('btn-open-layers').setAttribute('aria-expanded', 'false');
}
function openDrawer(id, buttonId) {
  closeDrawers();
  $(id).classList.add('is-open');
  $('drawer-backdrop').hidden = false;
  $(buttonId).setAttribute('aria-expanded', 'true');
}
$('btn-open-settings').addEventListener('click', () => {
  if ($('panel-settings').classList.contains('is-open')) closeDrawers();
  else openDrawer('panel-settings', 'btn-open-settings');
});
$('btn-open-layers').addEventListener('click', () => {
  if ($('panel-layers').classList.contains('is-open')) closeDrawers();
  else openDrawer('panel-layers', 'btn-open-layers');
});
document.querySelectorAll('[data-close-panel]').forEach((button) => button.addEventListener('click', closeDrawers));
$('drawer-backdrop').addEventListener('click', closeDrawers);
map2.on('click', closeDrawers);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });

/* ===================== Punto de derrame ===================== */
App.originMarker.addTo(map2);

function setOrigin(lat, lon) {
  S2.origin = { lat, lon };
  App.originMarker.setLatLng([lat, lon]);
  $('in-lat').value = lat.toFixed(4);
  $('in-lon').value = lon.toFixed(4);
}

function clearSim(message) {
  pause();
  S2.sim = null;
  $('results-section').open = false;
  if (S2.field) setTimeRange(0, S2.field.hours[S2.field.hours.length - 1]);
  updateTimeUI(true);
  if (message) setStatus(message, false);
  App.redraw();
}

map2.on('click', (e) => {
  const ll = e.latlng.wrap();
  setOrigin(ll.lat, ll.lng);
  clearSim('Punto colocado. Ajusta los parámetros y pulsa «Simular».');
});
App.originMarker.on('drag', () => {
  const ll = App.originMarker.getLatLng();
  $('in-lat').value = ll.lat.toFixed(4); $('in-lon').value = ll.lng.toFixed(4);
});
App.originMarker.on('dragend', () => {
  const ll = App.originMarker.getLatLng().wrap();
  setOrigin(ll.lat, ll.lng);
  clearSim('Punto movido. Pulsa «Simular» para recalcular.');
});
['in-lat', 'in-lon'].forEach((id) => $(id).addEventListener('change', () => {
  const latInput = $('in-lat'), lonInput = $('in-lon');
  if (!latInput.checkValidity() || !lonInput.checkValidity()) {
    (latInput.checkValidity() ? lonInput : latInput).reportValidity();
    setStatus('La latitud debe estar entre −90° y 90° y la longitud entre −180° y 180°.', true);
    return;
  }
  setOrigin(Number(latInput.value), Number(lonInput.value));
  clearSim('Coordenadas actualizadas. Pulsa «Simular».');
}));
<<<<<<< Updated upstream
setOrigin(19.15, -92.30);
=======

function applySharedSettings() {
  const params = new URLSearchParams(location.search);
  const fields = {
    lat: 'in-lat', lon: 'in-lon', start: 'in-start', duration: 'in-duration',
    particles: 'in-particles', k: 'in-k', factor: 'in-wave-factor', seed: 'in-seed',
  };
  Object.entries(fields).forEach(([key, id]) => {
    if (!params.has(key)) return;
    const input = $(id);
    input.value = params.get(key);
    if (!input.checkValidity()) input.value = input.defaultValue;
  });
}
applySharedSettings();
// Punto inicial: el que trae index.html en los campos de latitud y longitud (una sola fuente).
setOrigin(parseFloat($('in-lat').value), parseFloat($('in-lon').value));
>>>>>>> Stashed changes

/* ===================== Simulación ===================== */
function numberOf(id, fallback) {
  const raw = $(id).value.trim();
  return raw === '' ? fallback : Number(raw);
}

/* Acerca el mapa a la zona por donde pasa la mancha durante toda la simulación. */
function fitToTrajectory(sim) {
  let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
  for (let k = 0; k <= sim.steps; k++) {
    for (let q = 0; q < sim.n; q++) {
      const la = sim.lat[k][q], lo = sim.lon[k][q];
      if (la < la0) la0 = la; if (la > la1) la1 = la;
      if (lo < lo0) lo0 = lo; if (lo > lo1) lo1 = lo;
    }
  }
  map2.fitBounds([[la0, lo0], [la1, lo1]], { maxZoom: 9, padding: [90, 90] });
}

async function runSimulation() {
  const f = S2.field;
  if (!f) { setStatus('Todavía no hay datos de SEMAR.', true); return; }
  const required = ['in-lat', 'in-lon', 'in-duration', 'in-particles', 'in-k', 'in-wave-factor', 'in-seed'];
  const invalid = required.map((id) => $(id)).find((input) => !input.checkValidity());
  if (invalid) {
    invalid.reportValidity();
    setStatus('Revisa los campos marcados antes de simular.', true);
    return;
  }
  const startParsed = Date.parse(`${$('in-start').value}:00Z`);
  const startMs = Number.isNaN(startParsed) ? f.window[0] : startParsed;
  const seedRaw = $('in-seed').value.trim();
  const button = $('btn-simulate');
  const progress = $('simulation-progress');
  button.disabled = true;
  button.textContent = 'Calculando…';
  button.setAttribute('aria-busy', 'true');
  progress.hidden = false;
  setStatus('Calculando la trayectoria de las partículas…', false);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
<<<<<<< Updated upstream
    sim = Motor.simulate(f, numberOf('in-lat', NaN), numberOf('in-lon', NaN), startMs, {
      durationHours: numberOf('in-duration', 120),
      n: numberOf('in-particles', Motor.DEFAULT_PARTICLES),
      diffusivity: numberOf('in-k', Motor.DEFAULT_DIFFUSIVITY),
      drag: numberOf('in-drag', Motor.DRAG_COEF * 100) / 100,
      seed: seedRaw === '' ? null : Number(seedRaw),
      coast: S2.coast,
    });
  } catch (err) {
    if (err instanceof Motor.SimulationError) { setStatus(err.message, true); return; }
    throw err;
  }
=======
    let sim;
    try {
      sim = Motor.simulate(f, numberOf('in-lat', NaN), numberOf('in-lon', NaN), startMs, {
        durationHours: numberOf('in-duration', 120),
        n: numberOf('in-particles', Motor.DEFAULT_PARTICLES),
        diffusivity: numberOf('in-k', Motor.DEFAULT_DIFFUSIVITY),
        waveFactor: numberOf('in-wave-factor', Motor.DEFAULT_WAVE_FACTOR),
        seed: seedRaw === '' ? null : Number(seedRaw),
        coast: S2.coast,
      });
    } catch (err) {
      if (err instanceof Motor.SimulationError) { setStatus(err.message, true); return; }
      throw err;
    }
>>>>>>> Stashed changes

    pause();
    S2.sim = sim;
    $('results-section').open = true;
    fitToTrajectory(sim);
    const off = simOffset();
    setTimeRange(off, off + sim.steps * sim.dtHours);
    S2.h = off;
    updateTimeUI(true);
    const last = sim.steps;
    setStatus(`Simulación lista: ${sim.n} partículas durante ${Math.round(sim.params.durationHours)} h. ` +
              `Al final, ${sim.stranded[last]} varadas en costa.${sim.notes.length ? ' ' + sim.notes.join(' ') : ''}`, false);
    play();
  } finally {
    button.disabled = false;
    button.textContent = '▶ Simular';
    button.removeAttribute('aria-busy');
    progress.hidden = true;
  }
}

$('btn-simulate').addEventListener('click', runSimulation);
$('btn-clear').addEventListener('click', () => clearSim('Simulación borrada. Coloca un punto y pulsa «Simular».'));

/* ===================== Lectura bajo el cursor ===================== */
let lastLatLng = null;
function updateHover(latlng) {
  const f = S2.field;
  const ll = latlng ? latlng.wrap() : null;
  $('coord-cursor').textContent = ll ? fmtCoord(ll.lat, ll.lng) : '—';
  const cell = f && ll ? f.cellAt(ll.lat, ll.lng) : null;
  S2.hover = cell;
  if (!cell) {
    $('val-hs').textContent = ll && f ? 'Fuera del dominio de datos' : '—';
    $('val-wind').textContent = '—';
  } else {
    const fr = App.getInterp(), c = f.index(cell.i, cell.j);
    if (Number.isNaN(fr.hs[c])) {
      const c2 = f.fillIdx[c];
      if (S2.coast && !S2.coast.isLand(ll.lat, ll.lng) && c2 >= 0 && !Number.isNaN(fr.wu[c2])) {
        // agua costera (laguna, bahía) sin dato en la rejilla: se usa la celda más cercana
        const u = fr.wu[c2], v = fr.wv[c2];
        const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
        $('val-hs').textContent = 'Agua costera (sin dato de oleaje)';
        $('val-wind').textContent = `≈ ${Math.hypot(u, v).toFixed(1)} m/s · de ${compass(from)} (celda cercana)`;
      } else {
        $('val-hs').textContent = S2.coast ? 'Tierra' : 'Tierra (sin dato)';
        $('val-wind').textContent = '—';
      }
    } else {
      const u = fr.wu[c], v = fr.wv[c];
      const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;       // de dónde viene el viento
      $('val-hs').textContent = `${fr.hs[c].toFixed(2)} m`;
      $('val-wind').textContent = `${Math.hypot(u, v).toFixed(1)} m/s · de ${compass(from)} (${Math.round(from)}°)`;
    }
  }
  App.redraw();
}
map2.on('mousemove', (e) => { lastLatLng = e.latlng; updateHover(e.latlng); });
map2.on('mouseout', () => { lastLatLng = null; updateHover(null); });

/* ===================== Capas y vista ===================== */
document.querySelectorAll('input[name="base"]').forEach((r) => {
  r.addEventListener('change', () => { if (r.checked) App.setBase(r.value); });
});
$('chk-heat').addEventListener('change', (e) => { S2.showHeat = e.target.checked; App.redraw(); });
$('chk-arrows').addEventListener('change', (e) => { S2.showArrows = e.target.checked; App.redraw(); });
$('chk-coast').addEventListener('change', (e) => { S2.showCoast = e.target.checked; App.redraw(); });
$('chk-grid').addEventListener('change', (e) => { S2.showGrid = e.target.checked; App.redraw(); });
$('chk-flow').addEventListener('change', (e) => { S2.showFlow = e.target.checked; App.refreshLoop(); });
$('coord-format').addEventListener('change', (e) => {
  S2.fmt = e.target.value;
  updateHover(lastLatLng);
  updateTimeUI(true);
  App.redraw();
});

/* ===================== Carga de datos ===================== */
function showDataError(message) {
  $('source-badge').textContent = 'Sin datos';
  $('source-line').textContent = 'Sin datos';
  $('window-line').textContent = '—';
  setNotice(message, true);
  setStatus('No hay datos para simular.', true);
}

function applyField(f, first) {
  const changed = S2.field && S2.field.runTime !== f.runTime;
  S2.field = f;
  App.invalidateInterp();
  const runText = fmtDate(f.runTime, true);
  $('source-badge').textContent = `Corrida ${runText}`;
  $('source-line').textContent = f.sourceName;
  const [t0, t1] = f.window;
  let text = `Corrida ${runText}. Pronóstico del ${fmtDate(t0)} al ${fmtDate(t1)}, cada ${f.stepHours} h.`;
  if (f.lastModified) text += ` Archivo modificado: ${new Date(f.lastModified).toLocaleString('es-MX', { hour12: false })}.`;
  $('window-line').textContent = text;
  setWarnings(f.warnings);

  const start = $('in-start');
  start.min = toInputValue(t0); start.max = toInputValue(t1);
  if (changed || !start.value || !start.checkValidity()) start.value = toInputValue(t0);

  if (first) {
    const b = f.bounds();
    map2.fitBounds([[b.latMin, b.lonMin], [b.latMax, b.lonMax]], { padding: [20, 20] });
  }
  if (first || changed) {
    S2.sim = null;
    $('results-section').open = false;
    S2.h = 0;
    setTimeRange(0, f.hours[f.hours.length - 1]);
    setStatus(first ? 'Haz clic en el mapa para colocar el derrame y pulsa «Simular».' : 'Pronóstico nuevo cargado. Pulsa «Simular» para recalcular.', false);
  }
  if (changed) setNotice(`Llegó un pronóstico nuevo (corrida ${runText}). La simulación anterior se borró.`, false);
  else if (S2.coast) setNotice('', false);
  else setNotice(COAST_WARN, true);
  updateTimeUI(true);
  updateHover(lastLatLng);
  App.redraw();
}

async function loadCoastData() {
  if (S2.coast) return;
  try {
    S2.coast = await CoastData.loadCoast(COAST_URL);
  } catch (err) {
    S2.coast = null;
    setNotice(COAST_WARN, true);
  }
}

<<<<<<< Updated upstream
=======
/* La lectura automática requiere servidor porque fetch no funciona sobre file://. */
>>>>>>> Stashed changes
async function loadData(first) {
  if (location.protocol === 'file:') {
    showDataError('Abre la página desde un servidor local (no con doble clic): en la carpeta del proyecto ejecuta «python3 servidor.py» y entra a http://localhost:8000');
    return;
  }
  $('btn-reload').disabled = true;
  try {
    await loadCoastData();
<<<<<<< Updated upstream
    applyField(await SemarData.loadSemarWaves(DATA_URL), first);
  } catch (err) {
    showDataError(err.message || 'No se pudieron leer los datos.');
=======
    if (location.protocol === 'file:') {
      showNoData('Abre el simulador mediante el servidor local para cargar automáticamente el pronóstico de SEMAR.', false);
    } else {
      applyField(await SemarData.loadSemarWaves(DATA_URL), first);
    }
  } catch (err) {
    const msg = err.message || 'No se pudieron leer los datos.';
    reportLoadError(msg);
>>>>>>> Stashed changes
  } finally {
    $('btn-reload').disabled = false;
  }
}
$('btn-reload').addEventListener('click', () => loadData(false));

loadData(true);
