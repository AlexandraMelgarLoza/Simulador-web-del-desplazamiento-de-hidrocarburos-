// Mapa centrado en la Sonda de Campeche
const map = L.map('map', { zoomControl: true }).setView([19.3, -92.0], 7);

// Mapa base: OpenStreetMap atenuado con un filtro CSS (--map-tint en style.css) para
// que el mar y la trayectoria dominen. CARTO Dark Matter ya exige clave de API; si se
// consigue una, basta con cambiar la URL y la atribución aquí.
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  className: 'basemap',
  maxZoom: 12
}).addTo(map);

let points = [];
let trackLayer = null;   // halo, contorno, segmentos e inicio/fin
let trackSegments = [];  // un tramo por paso, coloreado según el tiempo
let pointStyles = [];    // color de cada punto, para atenuar los que aún no ocurren
let spillMarker = null;
let playTimer = null;
let currentIndex = 0;
let fieldInfo = null;
let pointsLayer = null;
let domainRect = null;

// Lienzo con tolerancia amplia para que los puntos se puedan tocar en el celular
const pointsRenderer = L.canvas({ tolerance: 8 });

const timeline = document.getElementById('timeline');
const timelineLabel = document.getElementById('timeline-label');
const statusText = document.getElementById('status-text');
const statusBox = document.getElementById('status');
const statusHint = document.getElementById('status-hint');
const mapProgress = document.getElementById('map-progress');
const mapEmpty = document.getElementById('map-empty');

// Estado con ícono: 'loading' (girando), 'ok' (listo) o 'empty' (no hay resultado; dice qué hacer)
function setStatus(kind, text, hint = '') {
  statusBox.dataset.kind = kind;
  statusText.textContent = text;
  statusHint.textContent = hint;
  statusHint.hidden = !hint;
}

// Barra de progreso sobre el mapa mientras se simula o se valida un archivo
function setMapBusy(on) {
  mapProgress.hidden = !on;
  map.getContainer().classList.toggle('is-busy', on);
}

const SIM_FAILED = ['La simulación no se ejecutó.',
  'Pulsa «Simular desde un punto» y elige otro lugar en el mar.'];
const warningsList = document.getElementById('warnings-list');
const fileInput = document.getElementById('file-input');

// Colores tomados de la paleta definida en style.css (:root)
const rootStyle = getComputedStyle(document.documentElement);
const token = (name) => rootStyle.getPropertyValue(name).trim();

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Marcador de la posición actual: punto con un pulso suave (se apaga con reduced-motion)
const markerIcon = (stranded) => L.divIcon({
  className: 'spill-marker',
  html: `<div class="spill-dot${stranded ? ' stranded' : ''}"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});
const spillIcon = markerIcon(false);
const strandedIcon = markerIcon(true);

const endpointIcon = (cls, title) => L.divIcon({
  className: `track-endpoint ${cls}`,
  html: `<span title="${title}"></span>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7]
});

// Mezcla dos colores #RRGGBB; t = 0 → a, t = 1 → b
function mixColor(a, b, t) {
  const ca = a.match(/\w\w/g).map(h => parseInt(h, 16));
  const cb = b.match(/\w\w/g).map(h => parseInt(h, 16));
  return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
}

// "01 oct 00:00": fecha corta para rangos
function fmtShort(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const month = d.toLocaleDateString('es-MX', { month: 'short' }).replace('.', '');
  return `${pad(d.getDate())} ${month} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderTrajectory(data) {
  stop();
  points = data.points;

  map.closePopup();
  if (trackLayer) map.removeLayer(trackLayer);
  if (spillMarker) map.removeLayer(spillMarker);
  if (pointsLayer) map.removeLayer(pointsLayer);

  const latlngs = points.map(p => [p.lat, p.lon]);
  const old = token('--track-old');
  const sea = token('--sea');
  const stranded = token('--stranded');
  const last = points.length - 1;
  // Color de cada paso: del ámbar apagado (inicio) al ámbar vivo (final); rojo si ya varó
  const colorAt = (i) => (stateOf(points[i]) === 'varado' ? stranded : mixColor(old, sea, last ? i / last : 1));

  const halo = L.polyline(latlngs, { color: sea, weight: 12, opacity: 0.1, interactive: false, lineCap: 'round', lineJoin: 'round' });
  const casing = L.polyline(latlngs, { color: token('--bg'), weight: 6, opacity: 0.7, interactive: false, lineCap: 'round', lineJoin: 'round' });
  trackSegments = latlngs.slice(1).map((ll, i) =>
    L.polyline([latlngs[i], ll], { color: colorAt(i + 1), weight: 3, interactive: false, lineCap: 'round' }));
  const start = L.marker(latlngs[0], { icon: endpointIcon('is-start', 'Inicio'), interactive: false, keyboard: false });
  const end = L.marker(latlngs[last], {
    icon: endpointIcon(stateOf(points[last]) === 'varado' ? 'is-end is-stranded' : 'is-end', 'Fin'),
    interactive: false, keyboard: false
  });
  trackLayer = L.layerGroup([halo, casing, ...trackSegments, start, end]).addTo(map);

  // maxZoom: con trayectorias cortas se conserva la costa a la vista como referencia
  map.fitBounds(halo.getBounds(), { padding: [40, 40], maxZoom: 9, animate: !reducedMotion.matches });

  // Un punto por paso de tiempo; al tocarlo muestra sus datos
  pointStyles = points.map((p, i) => colorAt(i));
  pointsLayer = L.layerGroup(points.map((p, i) =>
    L.circleMarker([p.lat, p.lon], {
      renderer: pointsRenderer, radius: 2.5, weight: 1,
      color: token('--bg'), fillColor: pointStyles[i], fillOpacity: 1
    }).on('click', (e) => (simMode ? simulateAt(e) : openPointPopup(nearestIndex(e))))
  )).addTo(map);

  spillMarker = L.marker(latlngs[0], { icon: spillIcon, keyboard: true, title: 'Posición actual', zIndexOffset: 1000 })
    .on('click', (e) => (simMode ? simulateAt(e) : openPointPopup(currentIndex)))
    .addTo(map);

  timeline.max = points.length - 1;
  currentIndex = 0;
  setFrame(0);

  renderSummary();
  showFileErrors([]);
  mapEmpty.hidden = true;
  setStatus('ok', `Trayectoria cargada: ${points.length} puntos.`);
  warningsList.innerHTML = '';
  (data.warnings || []).forEach(w => {
    const li = document.createElement('li');
    li.textContent = w;
    warningsList.appendChild(li);
  });
}

// --- Ventana emergente con los datos de un punto ---
const STATE_NAMES = { activo: 'En el mar', varado: 'Varado en costa', fuera_dominio: 'Fuera del área del pronóstico' };

function pointPopupHtml(p, i) {
  const wind = p.extra && p.extra.viento_ms;
  const state = STATE_NAMES[stateOf(p)] || 'Sin dato';
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  return `<div class="pt-popup"><strong>Punto ${i + 1} de ${points.length}</strong><table>` +
    row('Hora', fmtDate(p.t)) +
    row('Latitud', `${Math.abs(p.lat).toFixed(4)}° ${p.lat >= 0 ? 'N' : 'S'}`) +
    row('Longitud', `${Math.abs(p.lon).toFixed(4)}° ${p.lon <= 0 ? 'O' : 'E'}`) +
    row('Estado', state) +
    row('Viento', (wind === undefined || wind === null || wind === '') ? 'Sin dato' : `${Number(wind).toFixed(1)} m/s`) +
    '</table></div>';
}

// Los puntos se enciman con zoom bajo: se elige el más cercano al clic
function nearestIndex(e) {
  const q = map.mouseEventToLayerPoint(e.originalEvent);
  let best = 0;
  let bestDist = Infinity;
  points.forEach((p, i) => {
    const d = map.latLngToLayerPoint([p.lat, p.lon]).distanceTo(q);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

function openPointPopup(i) {
  if (simMode || simBusy) return;  // en modo simular, el clic es para elegir el punto de inicio
  const p = points[i];
  L.popup({ offset: [0, -4] }).setLatLng([p.lat, p.lon]).setContent(pointPopupHtml(p, i)).openOn(map);
}

// --- Leyenda del marcador (plegada de inicio en celular) ---
const narrowScreen = window.matchMedia('(max-width: 768px)');
const roomyMap = () => !narrowScreen.matches && map.getSize().x >= 720;
const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const div = L.DomUtil.create('details', 'legend');
  // Los clics en la leyenda no deben llegar al mapa (en modo simular dispararían una simulación)
  L.DomEvent.disableClickPropagation(div);
  div.open = roomyMap();
  div.innerHTML = '<summary class="float-head"><span class="card-title">Leyenda</span></summary>' +
    '<div class="legend-row"><span class="swatch-track"></span>Trayectoria (inicio → fin)</div>' +
    '<div class="legend-row"><span class="swatch-start"></span>Inicio · <span class="swatch-end"></span>Fin</div>' +
    '<div class="legend-row"><span class="dot dot-sea"></span>Posición en el mar</div>' +
    '<div class="legend-row"><span class="dot dot-stranded"></span>Varado en costa</div>' +
    '<div class="legend-row"><span class="dash"></span>Área del pronóstico SEMAR</div>';
  return div;
};
legend.addTo(map);

// --- Tarjeta de resumen ---
const STATE_LABELS = {
  activo: '<span class="state-tag"><span class="dot dot-sea"></span>En el mar</span>',
  varado: '<span class="state-tag"><span class="dot dot-stranded"></span>Varado en costa</span>',
  fuera_dominio: 'Salió del área del pronóstico'
};

function stateOf(p) { return p.extra && p.extra.estado; }

function renderSummary() {
  const first = points[0];
  const last = points[points.length - 1];
  const state = stateOf(last);
  const stranded = points.find(p => stateOf(p) === 'varado');

  document.getElementById('sum-count').textContent = points.length;
  document.getElementById('sum-state').innerHTML = STATE_LABELS[state] || 'Sin dato en el archivo';

  const arrival = document.getElementById('sum-arrival');
  arrival.hidden = document.getElementById('sum-arrival-label').hidden = !stranded;
  if (stranded) {
    const h = (new Date(stranded.t) - new Date(first.t)) / 3600000;
    setTwoLines(arrival, fmtDate(stranded.t), `tras ${h.toFixed(0)} h`);
  }
  setTwoLines(document.getElementById('sum-start'), fmtCoord(first.lat, first.lon), fmtDate(first.t));
  setTwoLines(document.getElementById('sum-end'), fmtCoord(last.lat, last.lon), fmtDate(last.t));
  summaryCard.hidden = false;
}

// Dato principal y, debajo, un dato secundario más tenue
function setTwoLines(el, main, sub) {
  const a = document.createElement('span');
  const b = document.createElement('span');
  a.textContent = main;
  b.textContent = sub;
  b.className = 'dd-sub';
  el.replaceChildren(a, b);
}

// El resumen empieza plegado si el mapa es angosto (iframe) para no tapar la trayectoria,
// y en celular/tableta para que la tarjeta de Simulación quede cerca del mapa
const summaryCard = document.getElementById('summary');
summaryCard.open = roomyMap();

// Exporta en el mismo formato que acepta /api/upload (fecha_hora, latitud, longitud, …)
function trajectoryTxt() {
  const extraCols = [];
  points.forEach(p => Object.keys(p.extra || {}).forEach(k => {
    if (!extraCols.includes(k)) extraCols.push(k);
  }));
  const clean = v => (v === undefined || v === null) ? '' : String(v).replace(/[,\r\n]/g, ' ');
  const rows = [['fecha_hora', 'latitud', 'longitud', ...extraCols].join(', ')];
  points.forEach(p => {
    rows.push([p.t.slice(0, 16).replace('T', ' '), p.lat.toFixed(4), p.lon.toFixed(4),
      ...extraCols.map(k => clean(p.extra[k]))].join(', '));
  });
  return rows.join('\n') + '\n';
}

document.getElementById('btn-export').addEventListener('click', () => {
  if (!points.length) return;
  const blob = new Blob([trajectoryTxt()], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trayectoria_${points[0].t.slice(0, 16).replace(/[-:]/g, '').replace('T', '_')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

const STATE_TEXT = { activo: 'en el mar', varado: 'varado en costa', fuera_dominio: 'fuera del área' };

function setFrame(i) {
  if (!points.length) return;
  currentIndex = Math.max(0, Math.min(i, points.length - 1));
  const p = points[currentIndex];
  spillMarker.setLatLng([p.lat, p.lon]);
  spillMarker.setIcon(stateOf(p) === 'varado' ? strandedIcon : spillIcon);
  // Recorrido hasta ahora a color pleno; el resto, tenue, como trazo pendiente
  trackSegments.forEach((seg, i) => seg.setStyle({ opacity: i < currentIndex ? 1 : 0.28 }));
  pointsLayer.getLayers().forEach((pt, i) => pt.setStyle({
    fillOpacity: i <= currentIndex ? 1 : 0.3, opacity: i <= currentIndex ? 1 : 0.3
  }));
  timeline.value = currentIndex;
  const h = (new Date(p.t) - new Date(points[0].t)) / 3600000;
  const state = STATE_TEXT[stateOf(p)];
  tlDate.textContent = fmtDate(p.t);
  timelineLabel.textContent =
    `+${h.toFixed(0)} h · punto ${currentIndex + 1} de ${points.length}${state ? ` · ${state}` : ''}`;
  btnPrev.disabled = currentIndex === 0;
  btnNext.disabled = currentIndex === points.length - 1;
}

// --- Reproducción: play/pausa, pasos y velocidad ---
const btnPlay = document.getElementById('btn-play');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const tlDate = document.getElementById('tl-date');
const BASE_STEP_MS = 150;
let speed = 1;

function setPlayButton(playing) {
  btnPlay.classList.toggle('playing', playing);
  btnPlay.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  btnPlay.title = playing ? 'Pausar' : 'Reproducir';
}

function stop() {
  clearInterval(playTimer);
  playTimer = null;
  setPlayButton(false);
}

function play() {
  if (!points.length) return;
  if (currentIndex >= points.length - 1) setFrame(0);  // al final, vuelve a empezar
  clearInterval(playTimer);
  playTimer = setInterval(() => {
    if (currentIndex >= points.length - 1) { stop(); return; }
    setFrame(currentIndex + 1);
  }, BASE_STEP_MS / speed);
  setPlayButton(true);
}

btnPlay.addEventListener('click', () => (playTimer ? stop() : play()));
btnPrev.addEventListener('click', () => { stop(); setFrame(currentIndex - 1); });
btnNext.addEventListener('click', () => { stop(); setFrame(currentIndex + 1); });

document.querySelectorAll('.btn-speed').forEach(btn => {
  btn.addEventListener('click', () => {
    speed = Number(btn.dataset.speed);
    document.querySelectorAll('.btn-speed').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', b === btn);
    });
    if (playTimer) play();  // aplica la nueva velocidad sin detenerse
  });
});

timeline.addEventListener('input', (e) => {
  stop();
  setFrame(Number(e.target.value));
});

// --- Avisos dentro de la página (sustituyen a alert()) ---
const notice = document.getElementById('notice');
const noticeTitle = document.getElementById('notice-title');
const noticeText = document.getElementById('notice-text');

function showNotice(title, text, kind = 'error') {
  noticeTitle.textContent = title;
  noticeText.textContent = text;
  notice.className = `notice ${kind}`;
  notice.hidden = false;
  // En celular el mapa puede quedar fuera de vista: lo traemos para que se lea el aviso
  const r = notice.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) {
    document.querySelector('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function hideNotice() { notice.hidden = true; }
document.getElementById('notice-close').addEventListener('click', hideNotice);

function fmtCoord(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon <= 0 ? 'O' : 'E'}`;
}

function domainText() {
  if (!fieldInfo) return 'el área que cubre el archivo de SEMAR';
  const b = fieldInfo.bounds;
  return `de ${b.lat_min}° a ${b.lat_max}° N y de ${Math.abs(b.lon_max)}° a ${Math.abs(b.lon_min)}° O`;
}

function windowText() {
  if (!fieldInfo) return 'dentro de la ventana del pronóstico';
  return `del ${fmtDate(fieldInfo.start_time)} al ${fmtDate(fieldInfo.end_time)} h`;
}

// Traduce el mensaje técnico del servidor a causa + qué hacer
function explainError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('tierra')) {
    return ['El punto elegido está en tierra',
      'El archivo de SEMAR no tiene datos ahí (tierra o costa; la rejilla mide unos 18 km). ' +
      'Pulsa «Simular desde un punto» y haz clic sobre el mar, un poco más lejos de la costa.'];
  }
  if (m.includes('fuera del dominio')) {
    return ['El punto está fuera del área del pronóstico',
      `El pronóstico de SEMAR solo cubre ${domainText()}. Elige un punto dentro del rectángulo punteado del mapa.`];
  }
  if (m.includes('ventana')) {
    return ['La hora de inicio está fuera del pronóstico',
      `Solo hay datos ${windowText()}. Elige una fecha y hora dentro de ese rango.`];
  }
  if (m.includes('faltan columnas')) {
    return ['Al archivo le faltan columnas',
      `${msg}. La primera línea debe ser el encabezado «fecha_hora, latitud, longitud».`];
  }
  if (m.includes('ningun punto valido')) {
    return ['El archivo no tiene puntos válidos',
      'Todas las líneas tienen errores. Revisa que las fechas sean como «2026-10-01 08:00» ' +
      'y las coordenadas números con punto decimal (por ejemplo 19.15, -92.30).'];
  }
  if (m.includes('no se pudo leer')) {
    return ['No se pudo leer el archivo',
      'Debe ser un texto separado por comas (.txt o .csv) con el encabezado «fecha_hora, latitud, longitud».'];
  }
  if (m.includes('semar')) {
    return ['Problema con el archivo de SEMAR', `${msg}. Avisa a quien administra el servidor.`];
  }
  return ['No se pudo completar la operación', msg || 'El servidor respondió con un error inesperado. Vuelve a intentarlo.'];
}

const NETWORK_ERROR = ['Sin conexión con el servidor',
  'No hubo respuesta. Revisa tu conexión y vuelve a intentarlo en unos segundos.'];

// fetch que siempre devuelve { ok, data }; solo lanza si no hay conexión
async function requestJSON(url, options) {
  const res = await fetch(url, options);
  let data = {};
  try { data = await res.json(); } catch (_) { /* respuesta sin JSON (p. ej. error 500) */ }
  return { ok: res.ok, data };
}

// --- Subida de archivo: botón, arrastrar y soltar, y líneas con error ---
const dropzone = document.getElementById('dropzone');
const dropLabel = document.getElementById('drop-label');
const fileErrors = document.getElementById('file-errors');
const fileErrorsCount = document.getElementById('file-errors-count');
const fileErrorsList = document.getElementById('file-errors-list');

// En pantallas táctiles no se puede arrastrar: se invita a tocar
const touchOnly = window.matchMedia('(hover: none)').matches;
const DROP_LABEL = touchOnly ? 'Toca para elegir tu TXT' : 'Arrastra aquí tu TXT';
dropLabel.textContent = DROP_LABEL;
document.getElementById('drop-hint').hidden = touchOnly;

// "linea 3: fecha_hora invalida, se omite" -> "Línea 3: fecha_hora inválida, se omite"
function prettyLineError(w) {
  return w.replace(/^linea/i, 'Línea').replace(/invalida/g, 'inválida');
}

function showFileErrors(warnings) {
  fileErrorsList.innerHTML = '';
  warnings.forEach(w => {
    const li = document.createElement('li');
    li.textContent = prettyLineError(w);
    fileErrorsList.appendChild(li);
  });
  fileErrorsCount.textContent = warnings.length;
  fileErrors.open = false;
  fileErrors.hidden = !warnings.length;
}

function invalidLinesNotice(data) {
  const bad = (data.warnings || []).length;
  if (!bad) return;
  showNotice(`Se omitieron ${bad} ${bad === 1 ? 'línea' : 'líneas'} del archivo`,
    `Se cargaron ${data.points.length} puntos válidos. Abre «Líneas con error» en el panel para ver ` +
    'cuáles son, corrígelas y vuelve a subir el archivo si las necesitas.', 'warn');
}

let uploadBusy = false;

async function uploadFile(file) {
  if (!file || uploadBusy) return;
  if (!/\.(txt|csv)$/i.test(file.name)) {
    showNotice('Formato de archivo no admitido',
      `«${file.name}» no es .txt ni .csv. Sube un texto separado por comas con el encabezado «fecha_hora, latitud, longitud».`);
    return;
  }

  hideNotice();
  uploadBusy = true;
  dropzone.classList.add('busy');
  dropLabel.textContent = `Validando «${file.name}»…`;
  setStatus('loading', 'Subiendo y validando archivo…');
  setMapBusy(true);
  const formData = new FormData();
  formData.append('file', file);

  try {
    const { ok, data } = await requestJSON('/api/upload', { method: 'POST', body: formData });
    if (!ok) {
      setStatus('empty', 'No se cargó el archivo.', 'Revisa el aviso del mapa, corrige el archivo y vuelve a subirlo.');
      showNotice(...explainError(data.error));
      return;
    }
    renderTrajectory({ points: data.points });
    setStatus('ok', `Archivo «${file.name}» cargado: ${data.points.length} puntos.`);
    showFileErrors(data.warnings || []);
    invalidLinesNotice(data);
  } catch (err) {
    setStatus('empty', 'No se cargó el archivo.', 'Revisa tu conexión y vuelve a subirlo.');
    showNotice(...NETWORK_ERROR);
  } finally {
    uploadBusy = false;
    setMapBusy(false);
    dropzone.classList.remove('busy');
    dropLabel.textContent = DROP_LABEL;
  }
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  fileInput.value = '';  // permite volver a subir el mismo archivo ya corregido
  uploadFile(file);
});

// Se acepta soltar el archivo en cualquier parte de la página
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  uploadFile(e.dataTransfer.files[0]);
});

// --- Motor Lagrangiano: modo "clic en el mapa para simular" ---
const simBtn = document.getElementById('btn-sim-mode');
const simLabel = document.getElementById('sim-label');
let simMode = false;
let simBusy = false;

function setSimMode(on) {
  simMode = on;
  simBtn.classList.toggle('active', on);
  simLabel.textContent = on ? 'Haz clic en el mar · Cancelar' : 'Simular desde un punto';
  map.getContainer().style.cursor = on ? 'crosshair' : '';
}

function setSimBusy(on) {
  simBusy = on;
  simBtn.disabled = on;
  simBtn.classList.toggle('busy', on);
  simBtn.setAttribute('aria-busy', on);
  setMapBusy(on);
  if (on) simLabel.textContent = 'Simulando…';
  else setSimMode(false);
}

// --- Hora de inicio, limitada a la ventana del pronóstico ---
// Fecha (input date) + hora y minutos en selectores de 24 h
const simStart = document.getElementById('sim-start');
const simHour = document.getElementById('sim-hour');
const simMin = document.getElementById('sim-min');
const simStartGroup = document.getElementById('sim-start-group');
const pad2 = (n) => String(n).padStart(2, '0');

for (let h = 0; h < 24; h++) simHour.add(new Option(pad2(h), pad2(h)));
[0, 15, 30, 45].forEach(m => simMin.add(new Option(pad2(m), pad2(m))));

// "2026-10-01T00:00" a partir de los tres campos; vacío si no hay fecha
function startFieldValue() {
  return simStart.value ? `${simStart.value}T${simHour.value}:${simMin.value}` : '';
}

function setStartFields(iso) {
  simStart.value = iso.slice(0, 10);
  simHour.value = iso.slice(11, 13);
  simMin.value = pad2(Math.floor(Number(iso.slice(14, 16)) / 15) * 15);
}

// Devuelve la hora elegida en formato ISO, o null si está fuera de la ventana
function chosenStartTime() {
  if (!fieldInfo) return undefined;
  const v = startFieldValue() || fieldInfo.start_time;
  if (v < fieldInfo.start_time || v > fieldInfo.end_time) return null;
  return v;
}

[simStart, simHour, simMin].forEach(el => el.addEventListener('change', () => {
  const outside = chosenStartTime() === null;
  simStartGroup.classList.toggle('is-invalid', outside);
  [simStart, simHour, simMin].forEach(f => f.setAttribute('aria-invalid', outside));
  if (outside) showNotice(...explainError('ventana'));
  else hideNotice();
}));

simBtn.addEventListener('click', () => {
  if (simBusy) return;
  if (!simMode && chosenStartTime() === null) {
    showNotice(...explainError('ventana'));
    simStart.focus();
    return;
  }
  setSimMode(!simMode);
  if (!simMode) return;
  hideNotice();
  map.closePopup();
  const r = map.getContainer().getBoundingClientRect();
  if (r.bottom < 80 || r.top > window.innerHeight - 80) {
    document.querySelector('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

function outsideDomain(lat, lon) {
  if (!fieldInfo) return false;
  const b = fieldInfo.bounds;
  return lat < b.lat_min || lat > b.lat_max || lon < b.lon_min || lon > b.lon_max;
}

// e: clic en el mapa, en un punto de la trayectoria o en el marcador
async function simulateAt(e) {
  if (!simMode || simBusy) return;
  const { lat, lng } = e.originalEvent ? map.mouseEventToLatLng(e.originalEvent) : e.latlng;

  if (outsideDomain(lat, lng)) {
    setSimMode(false);
    setStatus('empty', ...SIM_FAILED);
    showNotice(...explainError('fuera del dominio'));
    return;
  }
  const startTime = chosenStartTime();
  if (startTime === null) {
    setSimMode(false);
    showNotice(...explainError('ventana'));
    return;
  }

  hideNotice();
  setSimBusy(true);
  setStatus('loading', `Simulando desde ${fmtCoord(lat, lng)}…`, 'Hasta 120 h con el pronóstico de SEMAR.');
  try {
    const { ok, data } = await requestJSON('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: lat,
        lon: lng,
        start_time: startTime,
        duration_hours: 120,
        dt_hours: 1
      })
    });
    if (!ok) {
      setStatus('empty', ...SIM_FAILED);
      showNotice(...explainError(data.error));
      return;
    }
    renderTrajectory(data);
  } catch (err) {
    setStatus('empty', ...SIM_FAILED);
    showNotice(...NETWORK_ERROR);
  } finally {
    setSimBusy(false);
  }
}

map.on('click', simulateAt);

// Metadatos del archivo de SEMAR (ventana de tiempo del pronóstico)
requestJSON('/api/field-info')
  .then(({ ok, data: info }) => {
    const el = document.getElementById('field-info');
    if (!ok) {
      el.textContent = 'No se pudo leer el pronóstico de SEMAR; la simulación no estará disponible.';
      showNotice(...explainError(info.error));
      return;
    }
    fieldInfo = info;
    simStart.min = info.start_time.slice(0, 10);
    simStart.max = info.end_time.slice(0, 10);
    setStartFields(info.start_time);
    simStartGroup.disabled = false;
    const b = info.bounds;
    domainRect = L.rectangle([[b.lat_min, b.lon_min], [b.lat_max, b.lon_max]], {
      color: token('--domain'), weight: 1, opacity: 0.6, dashArray: '4 6', fill: false, interactive: false
    }).addTo(map);
    el.textContent = `Pronóstico SEMAR\n${fmtShort(info.start_time)} → ${fmtShort(info.end_time)}`;
  })
  .catch(() => showNotice(...NETWORK_ERROR));

// Carga inicial: datos de ejemplo
requestJSON('/api/sample')
  .then(({ ok, data }) => {
    if (!ok) throw new Error(data.error);
    renderTrajectory(data);
  })
  .catch(() => {
    setStatus('empty', 'No se pudo cargar la trayectoria de ejemplo.', 'Sube un archivo o simula desde un punto.');
    if (!points.length) mapEmpty.hidden = false;
  });

// Panel del ecosistema: abierto en escritorio, plegado en celular
const ecoPanel = document.getElementById('eco-panel');
const wideScreen = window.matchMedia('(min-width: 769px)');
ecoPanel.open = wideScreen.matches;
wideScreen.addEventListener('change', (e) => {
  ecoPanel.open = e.matches;
  map.invalidateSize();
});
