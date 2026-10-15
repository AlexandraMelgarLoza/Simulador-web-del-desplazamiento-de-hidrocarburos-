'use strict';

/* ===================== Estado ===================== */
const state = {
  source: 'directorio',        // 'directorio' | 'archivo'
  fieldId: null,               // id del archivo subido
  info: null,                  // metadatos del archivo de SEMAR en uso
  sim: null,                   // última simulación
  frame: 0,
  timer: null,
  mode: 'linea',               // 'linea' | 'particulas'
  base: 'normal',              // 'normal' | 'satelite'
  fmt: 'dec',                  // 'dec' | 'dms'
  gridOn: false,
  origin: { lat: 19.15, lon: -92.30 },
  cursor: null,
};

const $ = (id) => document.getElementById(id);

/* ===================== Mapa ===================== */
const map = L.map('map', { preferCanvas: true, zoomControl: false }).setView([19.3, -92.0], 7);
L.control.zoom({ position: 'topright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(map);

const baseLayers = {
  normal: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; colaboradores de OpenStreetMap',
    maxZoom: 13,
  }),
  satelite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imágenes &copy; Esri, Maxar, Earthstar Geographics y la comunidad de usuarios GIS',
    maxZoom: 13,
  }),
};
baseLayers.normal.addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

const originIcon = L.divIcon({
  className: 'origin-marker',
  html: '<span></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});
const originMarker = L.marker([state.origin.lat, state.origin.lon], {
  icon: originIcon,
  draggable: true,
  title: 'Punto de derrame (arrástralo para moverlo)',
}).addTo(map);

const STYLE_ACTIVE = { radius: 3.5, color: '#15171C', weight: 1, fillColor: '#E0A458', fillOpacity: 0.9, interactive: false };
const STYLE_STRANDED = { radius: 4, color: '#15171C', weight: 1, fillColor: '#E5604D', fillOpacity: 1, interactive: false };

const lineGroup = L.layerGroup();
const particleGroup = L.layerGroup();
let trackFull = null;
let trackCasing = null;
let trackDone = null;
let centerMarker = null;
let particles = [];

/* ===================== Utilidades ===================== */
async function readJson(res) {
  try {
    return await res.json();
  } catch (e) {
    return { error: `Respuesta inesperada del servidor (${res.status}).` };
  }
}

function fmtDate(iso, withYear) {
  const opts = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  if (withYear) opts.year = 'numeric';
  return new Date(iso).toLocaleString('es-MX', opts);
}

function dmsString(value) {
  const total = Math.round(Math.abs(value) * 36000);        // décimas de segundo de arco
  const d = Math.floor(total / 36000);
  const rem = total - d * 36000;
  const m = Math.floor(rem / 600);
  const s = (rem - m * 600) / 10;
  return `${d}° ${String(m).padStart(2, '0')}′ ${s.toFixed(1).padStart(4, '0')}″`;
}

function fmtCoord(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'O';
  if (state.fmt === 'dms') return `${dmsString(lat)} ${ns}, ${dmsString(lon)} ${ew}`;
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
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
  (list || []).forEach((w) => {
    const li = document.createElement('li');
    li.textContent = w;
    ul.appendChild(li);
  });
}

/* ===================== Coordenadas ===================== */
function refreshCoordReadouts() {
  $('coord-cursor').textContent = state.cursor ? fmtCoord(state.cursor.lat, state.cursor.lng) : '—';
  $('coord-origin').textContent = fmtCoord(state.origin.lat, state.origin.lon);
  if (state.sim) {
    const c = state.sim.center[state.frame];
    $('coord-center').textContent = fmtCoord(c[0], c[1]);
  } else {
    $('coord-center').textContent = '—';
  }
}

function setOrigin(lat, lon, fromInputs) {
  state.origin = { lat, lon };
  originMarker.setLatLng([lat, lon]);
  if (!fromInputs) {
    $('in-lat').value = lat.toFixed(4);
    $('in-lon').value = lon.toFixed(4);
  }
  refreshCoordReadouts();
}

map.on('mousemove', (e) => {
  state.cursor = e.latlng.wrap();
  $('coord-cursor').textContent = fmtCoord(state.cursor.lat, state.cursor.lng);
});
map.on('mouseout', () => {
  state.cursor = null;
  refreshCoordReadouts();
});
map.on('click', (e) => {
  const p = e.latlng.wrap();
  setOrigin(p.lat, p.lng, false);
});

originMarker.on('drag', (e) => {
  const p = e.target.getLatLng().wrap();
  state.origin = { lat: p.lat, lon: p.lng };
  $('in-lat').value = p.lat.toFixed(4);
  $('in-lon').value = p.lng.toFixed(4);
  refreshCoordReadouts();
});

['in-lat', 'in-lon'].forEach((id) => {
  $(id).addEventListener('change', () => {
    const lat = parseFloat($('in-lat').value);
    const lon = parseFloat($('in-lon').value);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      setOrigin(lat, lon, true);
      if (!map.getBounds().contains([lat, lon])) map.panTo([lat, lon]);
    }
  });
});

$('coord-format').addEventListener('change', (e) => {
  state.fmt = e.target.value;
  refreshCoordReadouts();
});

/* ----- Cuadrícula de coordenadas ----- */
const gridLayer = L.layerGroup();

function gridStep(zoom) {
  if (zoom <= 6) return 2;
  if (zoom === 7) return 1;
  if (zoom === 8) return 0.5;
  if (zoom === 9) return 0.25;
  return 0.1;
}

function gridLabel(value, step, pos, neg) {
  const dec = step >= 1 ? 0 : (step === 0.25 ? 2 : 1);
  return `${Math.abs(value).toFixed(dec)}°${value >= 0 ? pos : neg}`;
}

function drawGrid() {
  gridLayer.clearLayers();
  if (!state.gridOn) return;
  const b = map.getBounds();
  const step = gridStep(map.getZoom());
  const color = state.base === 'satelite' ? '#FFFFFF' : '#114B5F';
  const lineStyle = { color, weight: 1, opacity: 0.55, interactive: false };
  const south = b.getSouth(), north = b.getNorth(), west = b.getWest(), east = b.getEast();

  for (let k = Math.ceil(south / step); k * step <= north; k++) {
    const lat = +(k * step).toFixed(4);
    L.polyline([[lat, west], [lat, east]], lineStyle).addTo(gridLayer);
    L.marker([lat, west + (east - west) * 0.01], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'grid-label', html: gridLabel(lat, step, 'N', 'S'), iconSize: null, iconAnchor: [0, 6] }),
    }).addTo(gridLayer);
  }
  for (let k = Math.ceil(west / step); k * step <= east; k++) {
    const lon = +(k * step).toFixed(4);
    L.polyline([[south, lon], [north, lon]], lineStyle).addTo(gridLayer);
    L.marker([north - (north - south) * 0.015, lon], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'grid-label', html: gridLabel(lon, step, 'E', 'O'), iconSize: null, iconAnchor: [14, 0] }),
    }).addTo(gridLayer);
  }
}

$('chk-grid').addEventListener('change', (e) => {
  state.gridOn = e.target.checked;
  if (state.gridOn) gridLayer.addTo(map); else map.removeLayer(gridLayer);
  drawGrid();
});
map.on('moveend', drawGrid);

/* ===================== Mapa base ===================== */
function setBase(name) {
  if (name === state.base) return;
  map.removeLayer(baseLayers[state.base]);
  state.base = name;
  baseLayers[name].addTo(map);
  baseLayers[name].bringToBack();
  drawGrid();
}
document.querySelectorAll('input[name="base"]').forEach((r) => {
  r.addEventListener('change', () => { if (r.checked) setBase(r.value); });
});

/* ===================== Simulación: capas ===================== */
function clearSimulationLayers() {
  lineGroup.clearLayers();
  particleGroup.clearLayers();
  particles = [];
  trackFull = trackCasing = trackDone = centerMarker = null;
}

function buildSimulationLayers(sim) {
  clearSimulationLayers();
  const center = sim.center;
  trackFull = L.polyline(center, { color: '#E0A458', weight: 3, opacity: 0.35, interactive: false });
  trackCasing = L.polyline([], { color: '#15171C', weight: 7, opacity: 0.55, interactive: false });
  trackDone = L.polyline([], { color: '#E0A458', weight: 4, opacity: 1, interactive: false });
  centerMarker = L.circleMarker(center[0], {
    radius: 7, color: '#15171C', weight: 2, fillColor: '#E0A458', fillOpacity: 1, interactive: false,
  });
  lineGroup.addLayer(trackFull).addLayer(trackCasing).addLayer(trackDone).addLayer(centerMarker);

  for (let p = 0; p < sim.n_particles; p++) {
    const m = L.circleMarker([sim.lat[0][p], sim.lon[0][p]], STYLE_ACTIVE);
    m._st = 0;
    particles.push(m);
    particleGroup.addLayer(m);
  }
}

function applyMode() {
  if (state.mode === 'linea') {
    map.removeLayer(particleGroup);
    lineGroup.addTo(map);
  } else {
    map.removeLayer(lineGroup);
    particleGroup.addTo(map);
  }
  originMarker.setZIndexOffset(1000);
  if (state.sim) setFrame(state.frame);
}
document.querySelectorAll('input[name="modo"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    state.mode = r.value;
    applyMode();
  });
});

function setFrame(k) {
  const sim = state.sim;
  if (!sim) return;
  k = Math.max(0, Math.min(k, sim.times.length - 1));
  state.frame = k;
  $('timeline').value = k;

  if (state.mode === 'linea') {
    centerMarker.setLatLng(sim.center[k]);
    const done = sim.center.slice(0, k + 1);
    trackDone.setLatLngs(done);
    trackCasing.setLatLngs(done);
  } else {
    const la = sim.lat[k], lo = sim.lon[k], st = sim.status[k];
    for (let p = 0; p < particles.length; p++) {
      const m = particles[p];
      m.setLatLng([la[p], lo[p]]);
      if (m._st !== st[p]) {
        m._st = st[p];
        m.setStyle(st[p] === 0 ? STYLE_ACTIVE : STYLE_STRANDED);
      }
    }
  }

  const hours = Math.round(k * sim.dt_hours);
  $('timeline-label').textContent = `${fmtDate(sim.times[k], true)} · hora ${hours} de ${Math.round((sim.times.length - 1) * sim.dt_hours)}`;
  const stranded = sim.stranded[k], lost = sim.lost[k];
  const active = sim.n_particles - stranded - lost;
  $('frame-stats').textContent =
    `A la deriva: ${active} · Varadas: ${stranded}` + (lost ? ` · Fuera del dominio: ${lost}` : '');
  refreshCoordReadouts();
}

function simulationBounds(sim) {
  let minLa = state.origin.lat, maxLa = state.origin.lat, minLo = state.origin.lon, maxLo = state.origin.lon;
  for (let k = 0; k < sim.lat.length; k++) {
    const la = sim.lat[k], lo = sim.lon[k];
    for (let p = 0; p < la.length; p++) {
      if (la[p] < minLa) minLa = la[p];
      if (la[p] > maxLa) maxLa = la[p];
      if (lo[p] < minLo) minLo = lo[p];
      if (lo[p] > maxLo) maxLo = lo[p];
    }
  }
  return [[minLa, minLo], [maxLa, maxLo]];
}

/* ===================== Reproducción ===================== */
function pause() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function play() {
  if (!state.sim || state.timer) return;
  if (state.frame >= state.sim.times.length - 1) setFrame(0);
  state.timer = setInterval(() => {
    if (state.frame >= state.sim.times.length - 1) {
      pause();
      return;
    }
    setFrame(state.frame + 1);
  }, 120);
}

$('btn-play').addEventListener('click', play);
$('btn-pause').addEventListener('click', pause);
$('timeline').addEventListener('input', (e) => {
  pause();
  setFrame(Number(e.target.value));
});

/* ===================== Simulación: llamada al servidor ===================== */
function showSimulation(sim) {
  pause();
  state.sim = sim;
  buildSimulationLayers(sim);
  $('timeline').max = sim.times.length - 1;
  state.frame = 0;
  applyMode();
  setFrame(0);
  map.fitBounds(simulationBounds(sim), { padding: [60, 60], maxZoom: 10 });

  const hours = Math.round((sim.times.length - 1) * sim.dt_hours);
  const last = sim.times.length - 1;
  const stranded = sim.stranded[last], lost = sim.lost[last];
  const active = sim.n_particles - stranded - lost;
  let text = `${sim.n_particles} partículas durante ${hours} h. Al final: ${active} a la deriva y ${stranded} varadas en costa`;
  if (lost) text += `, ${lost} fuera del dominio`;
  $('status-text').textContent = text + '.';
  setWarnings(sim.notes);

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) play();
}

async function runSimulation() {
  pause();
  const lat = parseFloat($('in-lat').value);
  const lon = parseFloat($('in-lon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    $('status-text').textContent = 'Escribe una latitud y una longitud numéricas.';
    return;
  }
  const body = {
    lat, lon,
    start_time: $('in-start').value || undefined,
    duration_hours: $('in-duration').value,
    n_particles: $('in-particles').value,
    diffusivity: $('in-k').value,
    drag_pct: $('in-drag').value,
    source: state.source,
    field_id: state.fieldId,
  };

  const btn = $('btn-simulate');
  btn.disabled = true;
  $('status-text').textContent = 'Calculando la trayectoria…';
  setWarnings([]);
  try {
    const res = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readJson(res);
    if (!res.ok) {
      $('status-text').textContent = data.error;
      return;
    }
    showSimulation(data);
  } catch (err) {
    $('status-text').textContent = 'No se pudo conectar con el servidor.';
  } finally {
    btn.disabled = false;
  }
}
$('btn-simulate').addEventListener('click', runSimulation);

/* ===================== Datos de SEMAR: directorio / archivo ===================== */
function toInputValue(iso) {
  return iso.slice(0, 16);   // AAAA-MM-DDTHH:MM
}

function showDataError(message) {
  $('source-badge').textContent = 'Sin datos';
  $('source-line').textContent = 'Sin datos';
  $('window-line').textContent = '—';
  setNotice(message, true);
}

function applyInfo(info, initial) {
  const prev = state.info;
  const changed = prev && (prev.run_time !== info.run_time || prev.file !== info.file || prev.modified !== info.modified);
  state.info = info;

  const runText = fmtDate(info.run_time, true);
  $('source-badge').textContent = `Corrida ${runText} · ${info.source === 'archivo' ? 'archivo subido' : 'directorio'}`;
  $('source-line').textContent = info.source === 'archivo'
    ? `Archivo subido: ${info.file}`
    : `Directorio «${info.directory}»: ${info.file}`;
  let windowText = `Corrida ${runText}. Pronóstico del ${fmtDate(info.start_time)} al ${fmtDate(info.end_time)}, cada ${info.step_hours} h.`;
  if (info.source === 'directorio') {
    windowText += ` Revisado a las ${new Date(info.checked_at).toLocaleTimeString('es-MX', { hour12: false })}.`;
  }
  $('window-line').textContent = windowText;

  const startEl = $('in-start');
  startEl.min = toInputValue(info.start_time);
  startEl.max = toInputValue(info.end_time);
  if (initial || !startEl.value || startEl.value < startEl.min || startEl.value > startEl.max) {
    startEl.value = toInputValue(info.start_time);
  }

  if (changed && !initial) {
    setNotice(`Llegó un pronóstico nuevo (corrida ${runText}). Las próximas simulaciones lo usan.`, false);
    startEl.value = toInputValue(info.start_time);
  } else if (info.notice) {
    setNotice(info.notice, true);
  } else if (!changed) {
    if (initial) setNotice('', false);
  }
  const extra = (info.warnings || []).length ? info.warnings : null;
  if (extra && initial) setWarnings(extra);
}

async function refreshInfo(initial) {
  const qs = new URLSearchParams({ source: state.source });
  if (state.fieldId) qs.set('field_id', state.fieldId);
  try {
    const res = await fetch('/api/field-info?' + qs.toString());
    const data = await readJson(res);
    if (!res.ok) {
      showDataError(data.error);
      return null;
    }
    applyInfo(data, Boolean(initial));
    return data;
  } catch (err) {
    showDataError('No se pudo conectar con el servidor.');
    return null;
  }
}

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setNotice('Subiendo y validando el archivo…', false);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await readJson(res);
    if (!res.ok) {
      setNotice(data.error, true);
      return;
    }
    state.source = 'archivo';
    state.fieldId = data.field_id;
    applyInfo(data.info, true);
    setNotice('Archivo cargado. Las simulaciones usarán este archivo hasta que elijas «Usar directorio».', false);
  } catch (err) {
    setNotice('No se pudo subir el archivo.', true);
  } finally {
    e.target.value = '';
  }
});

$('btn-use-dir').addEventListener('click', async () => {
  state.source = 'directorio';
  state.fieldId = null;
  const info = await refreshInfo(true);
  if (info) setNotice('Leyendo del directorio. Si llega un archivo nuevo, se detecta solo.', false);
});

// Revisa la carpeta cada minuto (y al volver a la pestaña) para detectar corridas nuevas.
setInterval(() => { if (state.source === 'directorio') refreshInfo(false); }, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.source === 'directorio') refreshInfo(false);
});

/* ===================== Inicio ===================== */
setOrigin(state.origin.lat, state.origin.lon, false);
refreshInfo(true).then((info) => {
  if (info) runSimulation();      // demostración inicial con el punto por defecto
  else $('status-text').textContent = 'Sin datos de SEMAR. Sube el archivo o revisa la carpeta del servidor.';
});
