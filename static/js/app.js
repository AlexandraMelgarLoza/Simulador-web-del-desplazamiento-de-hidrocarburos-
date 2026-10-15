// Mapa centrado en la Sonda de Campeche
const map = L.map('map', { zoomControl: true }).setView([19.3, -92.0], 7);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 12
}).addTo(map);

let points = [];
let trackLine = null;
let spillMarker = null;
let playTimer = null;
let currentIndex = 0;
let fieldInfo = null;

const timeline = document.getElementById('timeline');
const timelineLabel = document.getElementById('timeline-label');
const statusText = document.getElementById('status-text');
const warningsList = document.getElementById('warnings-list');
const fileInput = document.getElementById('file-input');

const spillIcon = L.divIcon({
  className: 'spill-marker',
  html: '<div style="width:16px;height:16px;border-radius:50%;background:#E0A458;border:2px solid #15171C;box-shadow:0 0 0 4px rgba(224,164,88,0.25);"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

const strandedIcon = L.divIcon({
  className: 'spill-marker',
  html: '<div style="width:16px;height:16px;border-radius:50%;background:#C0392B;border:2px solid #15171C;box-shadow:0 0 0 4px rgba(192,57,43,0.3);"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

function fmtDate(iso) {
  return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderTrajectory(data) {
  points = data.points;

  if (trackLine) map.removeLayer(trackLine);
  if (spillMarker) map.removeLayer(spillMarker);

  const latlngs = points.map(p => [p.lat, p.lon]);
  trackLine = L.polyline(latlngs, { color: '#114B5F', weight: 3, opacity: 0.8 }).addTo(map);
  map.fitBounds(trackLine.getBounds(), { padding: [30, 30] });

  spillMarker = L.marker(latlngs[0], { icon: spillIcon }).addTo(map);

  timeline.max = points.length - 1;
  currentIndex = 0;
  setFrame(0);

  const last = points[points.length - 1];
  const hours = (new Date(last.t) - new Date(points[0].t)) / 3600000;
  statusText.textContent = (last.extra && last.extra.estado === 'varado')
    ? `${points.length} puntos. La mancha llega a costa tras ${hours.toFixed(0)} h.`
    : `${points.length} puntos cargados.`;
  warningsList.innerHTML = '';
  (data.warnings || []).forEach(w => {
    const li = document.createElement('li');
    li.textContent = w;
    warningsList.appendChild(li);
  });
}

function setFrame(i) {
  if (!points.length) return;
  currentIndex = Math.max(0, Math.min(i, points.length - 1));
  const p = points[currentIndex];
  spillMarker.setLatLng([p.lat, p.lon]);
  spillMarker.setIcon(p.extra && p.extra.estado === 'varado' ? strandedIcon : spillIcon);
  timeline.value = currentIndex;
  timelineLabel.textContent = `${new Date(p.t).toLocaleString('es-MX')}  (punto ${currentIndex + 1}/${points.length})`;
}

document.getElementById('btn-play').addEventListener('click', () => {
  if (playTimer || !points.length) return;
  playTimer = setInterval(() => {
    if (currentIndex >= points.length - 1) {
      clearInterval(playTimer);
      playTimer = null;
      return;
    }
    setFrame(currentIndex + 1);
  }, 150);
});

document.getElementById('btn-pause').addEventListener('click', () => {
  clearInterval(playTimer);
  playTimer = null;
});

timeline.addEventListener('input', (e) => {
  clearInterval(playTimer);
  playTimer = null;
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
  return `del ${fmtDate(fieldInfo.start_time)} al ${fmtDate(fieldInfo.end_time)}`;
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
      `El pronóstico de SEMAR solo cubre ${domainText()}. Elige un punto dentro de esa zona.`];
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

function invalidLinesNotice(data) {
  const bad = (data.warnings || []).length;
  if (!bad) return;
  showNotice(`Se omitieron ${bad} ${bad === 1 ? 'línea' : 'líneas'} del archivo`,
    `Se cargaron ${data.points.length} puntos válidos. Corrige las líneas indicadas en el panel ` +
    '«Estado» y vuelve a subir el archivo si las necesitas.', 'warn');
}

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  fileInput.value = '';  // permite volver a subir el mismo archivo ya corregido

  hideNotice();
  statusText.textContent = 'Subiendo y validando archivo…';
  const formData = new FormData();
  formData.append('file', file);

  try {
    const { ok, data } = await requestJSON('/api/upload', { method: 'POST', body: formData });
    if (!ok) {
      statusText.textContent = 'No se cargó el archivo.';
      warningsList.innerHTML = '';
      showNotice(...explainError(data.error));
      return;
    }
    renderTrajectory(data);
    invalidLinesNotice(data);
  } catch (err) {
    statusText.textContent = 'No se cargó el archivo.';
    showNotice(...NETWORK_ERROR);
  }
});

// --- Motor Lagrangiano: modo "clic en el mapa para simular" ---
const simBtn = document.getElementById('btn-sim-mode');
const simLabel = document.getElementById('sim-label');
let simMode = false;
let simBusy = false;

function setSimMode(on) {
  simMode = on;
  simBtn.classList.toggle('active', on);
  simLabel.textContent = on ? 'Haz clic en el mar (pulsa aquí para cancelar)' : 'Simular desde un punto';
  map.getContainer().style.cursor = on ? 'crosshair' : '';
}

function setSimBusy(on) {
  simBusy = on;
  simBtn.disabled = on;
  simBtn.classList.toggle('busy', on);
  simBtn.setAttribute('aria-busy', on);
  if (on) simLabel.textContent = 'Simulando…';
  else setSimMode(false);
}

simBtn.addEventListener('click', () => {
  if (simBusy) return;
  setSimMode(!simMode);
  if (!simMode) return;
  hideNotice();
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

map.on('click', async (e) => {
  if (!simMode || simBusy) return;
  const { lat, lng } = e.latlng;

  if (outsideDomain(lat, lng)) {
    setSimMode(false);
    statusText.textContent = 'La simulación no se ejecutó.';
    showNotice(...explainError('fuera del dominio'));
    return;
  }

  hideNotice();
  setSimBusy(true);
  statusText.textContent = `Simulando desde ${fmtCoord(lat, lng)}…`;
  try {
    const { ok, data } = await requestJSON('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: lat,
        lon: lng,
        start_time: fieldInfo ? fieldInfo.start_time : undefined,
        duration_hours: 120,
        dt_hours: 1
      })
    });
    if (!ok) {
      statusText.textContent = 'La simulación no se ejecutó.';
      showNotice(...explainError(data.error));
      return;
    }
    renderTrajectory(data);
  } catch (err) {
    statusText.textContent = 'La simulación no se ejecutó.';
    showNotice(...NETWORK_ERROR);
  } finally {
    setSimBusy(false);
  }
});

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
    el.textContent = `Pronóstico SEMAR: ${fmtDate(info.start_time)} a ${fmtDate(info.end_time)}.`;
  })
  .catch(() => showNotice(...NETWORK_ERROR));

// Carga inicial: datos de ejemplo
requestJSON('/api/sample')
  .then(({ ok, data }) => {
    if (!ok) throw new Error(data.error);
    renderTrajectory(data);
  })
  .catch(() => {
    statusText.textContent = 'No se pudo cargar la trayectoria de ejemplo. Sube un archivo o simula desde un punto.';
  });

// Panel del ecosistema: abierto en escritorio, plegado en celular
const ecoPanel = document.getElementById('eco-panel');
const wideScreen = window.matchMedia('(min-width: 769px)');
ecoPanel.open = wideScreen.matches;
wideScreen.addEventListener('change', (e) => {
  ecoPanel.open = e.matches;
  map.invalidateSize();
});
