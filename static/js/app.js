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

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  statusText.textContent = 'Subiendo y validando archivo…';
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) {
      statusText.textContent = `Error: ${data.error}`;
      warningsList.innerHTML = '';
      return;
    }
    renderTrajectory(data);
  } catch (err) {
    statusText.textContent = 'No se pudo conectar con el servidor.';
  }
});

// --- Motor Lagrangiano: modo "clic en el mapa para simular" ---
const simBtn = document.getElementById('btn-sim-mode');
let simMode = false;

simBtn.addEventListener('click', () => {
  simMode = !simMode;
  simBtn.classList.toggle('active', simMode);
  simBtn.textContent = simMode ? 'Haz clic en el mapa…' : 'Simular desde un punto';
});

map.on('click', async (e) => {
  if (!simMode) return;
  simMode = false;
  simBtn.classList.remove('active');
  simBtn.textContent = 'Simular desde un punto';

  statusText.textContent = 'Corriendo motor Lagrangiano…';
  try {
    const res = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: e.latlng.lat,
        lon: e.latlng.lng,
        start_time: fieldInfo ? fieldInfo.start_time : undefined,
        duration_hours: 120,
        dt_hours: 1
      })
    });
    const data = await res.json();
    if (!res.ok) {
      statusText.textContent = `Error: ${data.error}`;
      return;
    }
    renderTrajectory(data);
  } catch (err) {
    statusText.textContent = 'No se pudo correr la simulación.';
  }
});

// Metadatos del archivo de SEMAR (ventana de tiempo del pronóstico)
fetch('/api/field-info')
  .then(res => res.json())
  .then(info => {
    const el = document.getElementById('field-info');
    if (info.error) { el.textContent = info.error; return; }
    fieldInfo = info;
    el.textContent = `Pronóstico SEMAR: ${fmtDate(info.start_time)} a ${fmtDate(info.end_time)}.`;
  })
  .catch(() => {});

// Carga inicial: datos de ejemplo
fetch('/api/sample')
  .then(res => res.json())
  .then(renderTrajectory)
  .catch(() => { statusText.textContent = 'No se pudo cargar el ejemplo.'; });
