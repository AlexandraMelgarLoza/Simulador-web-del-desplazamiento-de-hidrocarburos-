'use strict';
/*
 * Mapa (Leaflet) + capas dibujadas con p5.js.
 *
 *  - Leaflet pone el mapa base (calles / satélite), el zoom y el arrastre.
 *  - p5.js dibuja encima, en un canvas transparente. Pasa de lat/lon a píxeles con una
 *    proyección Web Mercator propia (makeProjector) que coincide con la de Leaflet.
 *  - Capas, de abajo hacia arriba: oleaje (color) · cuadrícula · oleaje en movimiento ·
 *    flechas (dirección de propagación de la ola) · mancha de hidrocarburos · celda bajo el cursor.
 *  - El tiempo (App.state.h) son horas desde el primer paso del pronóstico y puede ser
 *    fraccionario: el oleaje y las partículas se interpolan, así el movimiento es continuo.
 */

const $ = (id) => document.getElementById(id);

const App = {
  state: {
    field: null,
    h: 0,                       // horas desde el inicio del pronóstico (fraccionario)
    base: 'oscuro',
    showHeat: true, showArrows: true, showFlow: false, showGrid: true, showCoast: false,
    showSlick: true, showParticles: true,
    coast: null,                // contorno fino de costa (CoastData.Coast)
    fmt: 'dec',
    hover: null,                // {i, j}
    origin: null,               // {lat, lon}
    sim: null,                  // resultado de Motor.simulate
    playing: false,
  },
  onFrame: null,                // la interfaz lo usa para avanzar la reproducción
};
const S = App.state;

/* ===================== Mapa base ===================== */
const map = L.map('map', { zoomControl: false, minZoom: 4 }).setView([19.0, -90.5], 6);
L.control.zoom({ position: 'topright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
App.map = map;

const baseLayers = {
  oscuro: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS User Community', maxZoom: 13,
  }),
  normal: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; colaboradores de OpenStreetMap', maxZoom: 13,
  }),
  satelite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imágenes &copy; Esri, Maxar, Earthstar Geographics y la comunidad de usuarios GIS', maxZoom: 13,
  }),
};
baseLayers[S.base].addTo(map);

App.setBase = (name) => {
  if (name === S.base) return;
  map.removeLayer(baseLayers[S.base]);
  S.base = name;
  baseLayers[name].addTo(map).bringToBack();
  buildLut();
  App.redraw();
};

/* Colores de las capas según el mapa de fondo (legibles en claro y en satélite) */
const THEME = {
  oscuro:   { flow: '170,205,240', grid: '170,195,225', gridText: '#B8C7DD', halo: 'rgba(8,14,26,0.85)', arrowCore: '#E8F1FB', arrowCase: 'rgba(6,12,24,0.75)',
              dot: '#FFA23A', dotCase: 'rgba(20,10,0,0.9)', trail: '255,162,58', hull: '#FFB347', hullCase: 'rgba(6,12,24,0.75)',
              hullFill: 'rgba(255,138,31,0.08)', slickAlpha: 0.4, sprite: 'glow', heatAlpha: 170,
              hover: '#E8F1FB', coastCase: 'rgba(6,12,24,0.8)', coastCore: '#FFB347',
              pathCase: 'rgba(6,12,24,0.85)', pathCore: '#6EA8FF', crossCase: 'rgba(6,12,24,0.9)', crossCore: '#FFFFFF', strandCase: '#0D1526' },
  normal:   { flow: '14,58,70',   grid: '14,58,70',   gridText: '#0E3A46', halo: 'rgba(255,255,255,0.92)', arrowCore: '#0E3A46', arrowCase: 'rgba(255,255,255,0.85)',
              dot: '#FF9F1C', dotCase: 'rgba(30,18,8,0.9)', trail: '196,92,0', hull: '#C2600A', hullCase: 'rgba(255,255,255,0.85)',
              hullFill: 'rgba(43,30,21,0.06)', slickAlpha: 0.25, sprite: 'brown', heatAlpha: 150,
              hover: '#0A6B74', coastCase: 'rgba(255,255,255,0.85)', coastCore: '#B4540A',
              pathCase: 'rgba(255,255,255,0.9)', pathCore: '#0A6B74', crossCase: 'rgba(255,255,255,0.95)', crossCore: '#0A6B74', strandCase: '#FFFFFF' },
  satelite: { flow: '255,255,255', grid: '255,255,255', gridText: '#FFFFFF', halo: 'rgba(0,20,30,0.85)',    arrowCore: '#FFFFFF', arrowCase: 'rgba(5,25,35,0.8)',
              dot: '#FFD23F', dotCase: 'rgba(20,12,6,0.9)',  trail: '255,210,63', hull: '#FFB347', hullCase: 'rgba(10,20,25,0.7)',
              hullFill: 'rgba(43,30,21,0.06)', slickAlpha: 0.25, sprite: 'brown', heatAlpha: 150,
              hover: '#FFFFFF', coastCase: 'rgba(255,255,255,0.85)', coastCore: '#B4540A',
              pathCase: 'rgba(255,255,255,0.9)', pathCore: '#0A6B74', crossCase: 'rgba(255,255,255,0.95)', crossCore: '#0A6B74', strandCase: '#FFFFFF' },
};

/* Marcador del punto de derrame: se puede arrastrar. */
const originIcon = L.divIcon({ className: 'origin-marker', html: '<span></span>', iconSize: [24, 24], iconAnchor: [12, 12] });
App.originMarker = L.marker([19.15, -92.30], { icon: originIcon, draggable: true, keyboard: false, title: 'Punto de derrame' });

/* ===================== Proyección ===================== */
function makeProjector() {
  const z = map.getZoom(), size = 256 * Math.pow(2, z);
  const tl = map.getPixelBounds().min;
  const rad = Math.PI / 180;
  return {
    z, size,
    x: (lon) => (lon + 180) / 360 * size - tl.x,
    y: (lat) => {
      const s = Math.sin(Math.max(-85, Math.min(85, lat)) * rad);
      return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size - tl.y;
    },
    degPerPx: 360 / size,                                    // grados de longitud por píxel
    mPerPx: (lat) => 40075016.686 * Math.cos(lat * rad) / size,
  };
}
App.makeProjector = makeProjector;

/* ===================== Colores del oleaje ===================== */
const HS_MAX = 3;   // m; la escala de color llega hasta aquí
const HS_STOPS_LIGHT = [[0, '#8FD3D8'], [0.8, '#4FB3BF'], [1.5, '#F2C66D'], [2.2, '#EE8A5B'], [3, '#B5304A']];
const HS_STOPS_DARK = [[0, '#16466A'], [0.8, '#1E7A94'], [1.5, '#3FB6A8'], [2.2, '#E9C46A'], [3, '#F26B4F']];
const hexRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
const LUT = [];   // 256 colores [r, g, b]; se reconstruye al cambiar de mapa base
function buildLut() {
  const stops = S.base === 'oscuro' ? HS_STOPS_DARK : HS_STOPS_LIGHT;
  LUT.length = 0;
  for (let n = 0; n < 256; n++) {
    const v = n / 255 * HS_MAX;
    let s = 0;
    while (s < stops.length - 2 && v > stops[s + 1][0]) s++;
    const [v0, c0] = stops[s], [v1, c1] = stops[s + 1];
    const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
    const a = hexRgb(c0), b = hexRgb(c1);
    LUT.push(a.map((x, k) => Math.round(x + (b[k] - x) * t)));
  }
  const css = stops.map(([v, c]) => `${c} ${(v / HS_MAX * 100).toFixed(0)}%`).join(', ');
  $('legend-bar').style.background = `linear-gradient(to right, ${css})`;
}
buildLut();

/* ===================== Campo interpolado a la hora actual ===================== */
let interp = null, interpKey = null;
App.getInterp = () => {
  const f = S.field;
  if (!f) return null;
  if (!interp || interp.su.length !== f.nlat * f.nlon) { interp = f.makeFrame(); interpKey = null; }
  const key = `${S.h.toFixed(4)}|${f.runTime}`;
  if (key !== interpKey) { f.interpolateInto(S.h, interp); interpKey = key; }
  return interp;
};
App.invalidateInterp = () => { interpKey = null; };

/* ===================== Capa de p5.js ===================== */
const host = document.createElement('div');
host.id = 'overlay';
map.getContainer().appendChild(host);

let looping = true;

/* Sprite (círculo difuso) para la capa de densidad de la mancha. Es tenue a propósito: los
   círculos se acumulan y la capa completa se dibuja con opacidad máxima de ~25 % (40 % en el mapa oscuro; ver slickAlpha en THEME). */
function makeSprite(rgb, a0, a1) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${rgb},${a0})`);
  grad.addColorStop(0.55, `rgba(${rgb},${a1})`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return c;
}
const spriteBrown = makeSprite('43,30,21', 0.40, 0.22);     // para mapas claros y satélite
const spriteGlow = makeSprite('255,138,31', 0.55, 0.28);    // para el mapa oscuro

/* Partículas del flujo de oleaje (las líneas en movimiento). Solo es visual: la deriva de Stokes
   es de ~0.1 m/s, así que se exagera para que el movimiento se note en pantalla. */
const FLOW_N = 220, TRAIL = 9, FLOW_PX_PER_MS = 300;   // px/s por cada m/s de deriva
const flow = {
  lat: new Float32Array(FLOW_N), lon: new Float32Array(FLOW_N),
  age: new Float32Array(FLOW_N), life: new Float32Array(FLOW_N),
  hLat: new Float32Array(FLOW_N * TRAIL), hLon: new Float32Array(FLOW_N * TRAIL),
  px: new Float32Array(FLOW_N * TRAIL), py: new Float32Array(FLOW_N * TRAIL),
  ready: false,
};

new p5((p) => {
  App.p5 = p;
  let heatCanvas = null, heatCtx = null, heatImg = null;

  p.setup = () => {
    p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
    p.createCanvas(host.clientWidth, host.clientHeight).parent(host);
    p.frameRate(30);
  };

  /* ---------- capas ---------- */
  function drawHeat(ctx, f, fr, rx, ry, W, H) {
    if (!heatCanvas || heatCanvas.width !== f.nlon || heatCanvas.height !== f.nlat) {
      heatCanvas = document.createElement('canvas');
      heatCanvas.width = f.nlon; heatCanvas.height = f.nlat;
      heatCtx = heatCanvas.getContext('2d');
      heatImg = heatCtx.createImageData(f.nlon, f.nlat);
    }
    const d = heatImg.data, hs = fr.hs;
    for (let c = 0; c < hs.length; c++) {
      const v = hs[c], o = c * 4;
      if (Number.isNaN(v)) { d[o + 3] = 0; continue; }
      const col = LUT[Math.max(0, Math.min(255, Math.round(v / HS_MAX * 255)))];
      const i = Math.floor(c / f.nlon), j = c % f.nlon;
      let edge = 4;
      for (let radius = 1; radius <= 3 && edge === 4; radius++) {
        for (let di = -radius; di <= radius && edge === 4; di++) {
          for (let dj = -radius; dj <= radius; dj++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== radius) continue;
            const ni = i + di, nj = j + dj;
            if (ni < 0 || ni >= f.nlat || nj < 0 || nj >= f.nlon || Number.isNaN(hs[ni * f.nlon + nj])) {
              edge = radius;
              break;
            }
          }
        }
      }
      const fade = edge === 1 ? 0.3 : edge === 2 ? 0.56 : edge === 3 ? 0.8 : 1;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2];
      d[o + 3] = Math.round(THEME[S.base].heatAlpha * fade);
    }
    heatCtx.putImageData(heatImg, 0, 0);
    ctx.imageSmoothingEnabled = true;
    const x0 = rx[0], w = rx[f.nlon] - rx[0];
    if (x0 > W || x0 + w < 0) return;
    // Una tira por renglón: así cada renglón cae en su latitud exacta (Mercator no es lineal)
    for (let i = 0; i < f.nlat; i++) {
      const top = ry[i + 1], h = ry[i] - ry[i + 1];
      if (top > H || top + h < 0) continue;
      ctx.drawImage(heatCanvas, 0, i, f.nlon, 1, x0, top, w, h);
    }
  }

  const NICE = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  function niceStep(degPerPx) {
    const want = 110 * degPerPx;                       // ≈ 110 px entre líneas
    return NICE.find((s) => s >= want) || 10;
  }

  function drawGrid(ctx, proj, W, H) {
    const th = THEME[S.base];
    const b = map.getBounds();
    const step = niceStep(proj.degPerPx);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${th.grid},0.28)`;
    ctx.beginPath();
    const lons = [], lats = [];
    for (let lo = Math.ceil(b.getWest() / step) * step; lo <= b.getEast(); lo += step) lons.push(lo);
    for (let la = Math.ceil(b.getSouth() / step) * step; la <= b.getNorth(); la += step) lats.push(la);
    lons.forEach((lo) => { const x = Math.round(proj.x(lo)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); });
    lats.forEach((la) => { const y = Math.round(proj.y(la)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); });
    ctx.stroke();

    ctx.font = '700 11px Manrope, Inter, Arial, sans-serif';
    ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = th.halo; ctx.fillStyle = th.gridText;
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    lons.forEach((lo) => {
      const x = proj.x(lo);
      if (x < 40 || x > W - 70) return;
      const t = App.fmtLon(lo, step);
      ctx.strokeText(t, x + 4, 5); ctx.fillText(t, x + 4, 5);
    });
    ctx.textBaseline = 'bottom';
    lats.forEach((la) => {
      const y = proj.y(la);
      if (y < 24 || y > H - 20) return;
      const t = App.fmtLat(la, step);
      ctx.strokeText(t, 6, y - 3); ctx.fillText(t, 6, y - 3);
    });
    ctx.restore();
  }

  function drawArrows(ctx, f, fr, proj, rx, ry, W, H) {
    const th = THEME[S.base];
    const cellPx = rx[1] - rx[0];
    const step = Math.max(1, Math.ceil(52 / cellPx));
    const maxLen = cellPx * step * 0.85;
    const shafts = new Path2D();
    for (let i = Math.floor(step / 2); i < f.nlat; i += step) {
      const cy = (ry[i] + ry[i + 1]) / 2;
      if (cy < -20 || cy > H + 20) continue;
      for (let j = Math.floor(step / 2); j < f.nlon; j += step) {
        const c = i * f.nlon + j, u = fr.su[c], v = fr.sv[c];
        if (Number.isNaN(u)) continue;
        const cx = (rx[j] + rx[j + 1]) / 2;
        if (cx < -20 || cx > W + 20) continue;
        // Dirección: hacia donde se propaga la ola. Largo: proporcional a la altura de ola.
        const len = Math.max(9, Math.min(maxLen, 8 + fr.hs[c] * 9));
        const ang = Math.atan2(-v, u), ca = Math.cos(ang), sa = Math.sin(ang);
        const x1 = cx - ca * len / 2, y1 = cy - sa * len / 2, x2 = cx + ca * len / 2, y2 = cy + sa * len / 2;
        const head = Math.min(6, len * 0.42);
        shafts.moveTo(x1, y1); shafts.lineTo(x2, y2);
        shafts.moveTo(x2 - Math.cos(ang - 0.45) * head, y2 - Math.sin(ang - 0.45) * head);
        shafts.lineTo(x2, y2);
        shafts.lineTo(x2 - Math.cos(ang + 0.45) * head, y2 - Math.sin(ang + 0.45) * head);
      }
    }
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = th.arrowCase; ctx.lineWidth = 3; ctx.stroke(shafts);
    ctx.strokeStyle = th.arrowCore; ctx.lineWidth = 1.3; ctx.stroke(shafts);
    ctx.restore();
  }

  /* Deriva por oleaje en un punto (m/s, factor 1): null si es tierra. Con costa fina, las aguas
     costeras sin dato (lagunas, bahías) usan el oleaje de la celda con dato más cercana. */
  function driftAt(f, lat, lon) {
    const cell = f.cellAt(lat, lon);
    if (!cell) return null;
    let c = cell.i * f.nlon + cell.j;
    if (S.coast) {
      if (S.coast.isLand(lat, lon)) return null;
      c = f.fillIdx[c];
      if (c < 0) return null;
    }
    const u = interp.su[c], v = interp.sv[c];
    return Number.isNaN(u) ? null : [u, v];
  }

  /* ----- Flujo de oleaje: líneas que avanzan en la dirección de propagación de la ola ----- */
  function respawn(n, f, b) {
    for (let t = 0; t < 6; t++) {
      const la = b.getSouth() + Math.random() * (b.getNorth() - b.getSouth());
      const lo = b.getWest() + Math.random() * (b.getEast() - b.getWest());
      flow.lat[n] = la; flow.lon[n] = lo;
      if (driftAt(f, la, lo)) break;
    }
    flow.age[n] = 0;
    flow.life[n] = 45 + Math.random() * 70;
    for (let k = 0; k < TRAIL; k++) { flow.hLat[n * TRAIL + k] = flow.lat[n]; flow.hLon[n * TRAIL + k] = flow.lon[n]; }
  }

  function stepFlow(f, proj, dt, W, H) {
    const b = map.getBounds();
    if (!flow.ready) {
      for (let n = 0; n < FLOW_N; n++) { respawn(n, f, b); flow.age[n] = Math.random() * flow.life[n]; }
      flow.ready = true;
    }
    const kDeg = proj.degPerPx, rad = Math.PI / 180;
    for (let n = 0; n < FLOW_N; n++) {
      let lat = flow.lat[n], lon = flow.lon[n];
      const drift = driftAt(f, lat, lon);
      const x = proj.x(lon), y = proj.y(lat);
      if (!drift || flow.age[n] >= flow.life[n] || x < -30 || x > W + 30 || y < -30 || y > H + 30) {
        respawn(n, f, b); continue;
      }
      const u = drift[0], v = drift[1];
      // desplazamiento en píxeles → grados (en latitud, 1 px = kDeg·cos(lat) grados)
      lon += u * FLOW_PX_PER_MS * dt * kDeg;
      lat += v * FLOW_PX_PER_MS * dt * kDeg * Math.cos(lat * rad);
      flow.lat[n] = lat; flow.lon[n] = lon; flow.age[n] += dt * 30;
      const o = n * TRAIL;
      for (let k = TRAIL - 1; k > 0; k--) { flow.hLat[o + k] = flow.hLat[o + k - 1]; flow.hLon[o + k] = flow.hLon[o + k - 1]; }
      flow.hLat[o] = lat; flow.hLon[o] = lon;
    }
  }

  function drawFlow(ctx, proj) {
    const th = THEME[S.base];
    const N = FLOW_N * TRAIL;
    for (let q = 0; q < N; q++) { flow.px[q] = proj.x(flow.hLon[q]); flow.py[q] = proj.y(flow.hLat[q]); }
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineWidth = 1.3;
    for (let k = 0; k < TRAIL - 1; k++) {
      ctx.strokeStyle = `rgba(${th.flow},${(0.5 * (1 - k / (TRAIL - 1))).toFixed(3)})`;
      ctx.beginPath();
      for (let n = 0; n < FLOW_N; n++) {
        const a = n * TRAIL + k;
        const fade = Math.min(1, flow.age[n] / 8, (flow.life[n] - flow.age[n]) / 8);
        if (fade < 0.35) continue;
        if (flow.px[a] === flow.px[a + 1] && flow.py[a] === flow.py[a + 1]) continue;
        ctx.moveTo(flow.px[a], flow.py[a]); ctx.lineTo(flow.px[a + 1], flow.py[a + 1]);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ----- Línea de costa del modelo (referencia) ----- */
  function drawCoast(ctx, proj) {
    const c = S.coast;
    if (!c) return;
    const [lo0, la0, lo1, la1] = c.bbox, eps = 1e-6;
    const onEdge = (q) => Math.abs(q[0] - lo0) < eps || Math.abs(q[0] - lo1) < eps || Math.abs(q[1] - la0) < eps || Math.abs(q[1] - la1) < eps;
    const path = new Path2D();
    for (const ring of c.rings) {
      for (let k = 0; k < ring.length - 1; k++) {
        const a = ring[k], b = ring[k + 1];
        if (onEdge(a) && onEdge(b)) continue;          // bordes del recorte, no son costa
        path.moveTo(proj.x(a[0]), proj.y(a[1])); path.lineTo(proj.x(b[0]), proj.y(b[1]));
      }
    }
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const th = THEME[S.base];
    ctx.strokeStyle = th.coastCase; ctx.lineWidth = 3.4; ctx.stroke(path);
    ctx.strokeStyle = th.coastCore; ctx.lineWidth = 1.4; ctx.stroke(path);
    ctx.restore();
  }

  /* ----- Mancha de hidrocarburos ----- */
  /* Posición (lat, lon) de cada partícula en el cuadro fraccionario fr, interpolada entre cuadros. */
  function positionsAt(sim, fr, outLat, outLon) {
    const f0 = Math.floor(fr), f1 = Math.min(f0 + 1, sim.steps), a = fr - f0;
    const la0 = sim.lat[f0], la1 = sim.lat[f1], lo0 = sim.lon[f0], lo1 = sim.lon[f1];
    for (let q = 0; q < sim.n; q++) {
      outLat[q] = la0[q] + (la1[q] - la0[q]) * a;
      outLon[q] = lo0[q] + (lo1[q] - lo0[q]) * a;
    }
  }

  /* Capa aparte para la mancha: los círculos se acumulan aquí (más partículas juntas = más densa)
     y luego se pega sobre el mapa con la opacidad del tema (slickAlpha, ~25 % en claro y ~40 %
     en oscuro), así la mancha deja ver las partículas y el mapa. */
  /* Radio que representa cada partícula en el terreno, en METROS. Se convierte a píxeles con la
     escala del mapa en la latitud de cada partícula (proj.mPerPx), así la mancha tiene tamaño real
     y crece o se encoge correctamente con el zoom. El mínimo en píxeles es solo para que se vea. */
  const PARTICLE_RADIUS_M = 1000;
  const MIN_RADIUS_PX = 1.5;
  const TRAIL_HOURS = 4;        // largo de la estela de cada partícula (horas de simulación)
  const TRAIL_SAMPLES = 8;      // segmentos por estela
  let slickCanvas = null, slickCtx = null;
  function slickLayer(W, H) {
    const d = p.pixelDensity(), w = Math.round(W * d), h = Math.round(H * d);
    if (!slickCanvas) { slickCanvas = document.createElement('canvas'); slickCtx = slickCanvas.getContext('2d'); }
    if (slickCanvas.width !== w || slickCanvas.height !== h) { slickCanvas.width = w; slickCanvas.height = h; }
    slickCtx.setTransform(d, 0, 0, d, 0, 0);
    slickCtx.clearRect(0, 0, W, H);
    return slickCtx;
  }

  function drawSpill(ctx, proj, W, H) {
    const sim = S.sim;
    if (!sim) return;
    const th = THEME[S.base];
    const n = sim.n;
    const fr = Math.max(0, Math.min(sim.steps, (S.h - (sim.startMs - S.field.times[0]) / 3.6e6) / sim.dtHours));
    const f0 = Math.floor(fr), f1 = Math.min(f0 + 1, sim.steps), a = fr - f0;
    const stat = sim.status[a < 0.5 ? f0 : f1];
    const lats = new Float64Array(n), lons = new Float64Array(n);
    positionsAt(sim, fr, lats, lons);
    const xs = new Float32Array(n), ys = new Float32Array(n);
    for (let q = 0; q < n; q++) { xs[q] = proj.x(lons[q]); ys[q] = proj.y(lats[q]); }

    // 1) Mancha (densidad): relleno suave, máximo ~25 % de opacidad, y su contorno bien visible
    if (S.showSlick) {
      const sctx = slickLayer(W, H);
      for (let q = 0; q < n; q++) {
        if (stat[q] === Motor.STATUS_OUT) continue;
        const r = Math.max(MIN_RADIUS_PX, PARTICLE_RADIUS_M / proj.mPerPx(lats[q]));
        sctx.drawImage(th.sprite === 'glow' ? spriteGlow : spriteBrown, xs[q] - r, ys[q] - r, r * 2, r * 2);
      }
      ctx.save();
      ctx.globalAlpha = th.slickAlpha;
      ctx.drawImage(slickCanvas, 0, 0, W, H);
      ctx.restore();

      // Contorno: envolvente de las partículas en el agua (las mismas del área en "Estado de la mancha")
      const pts = [];
      for (let q = 0; q < n; q++) if (stat[q] === Motor.STATUS_OK) pts.push([xs[q], ys[q]]);
      const hl = Motor.convexHull(pts);
      if (hl.length >= 3) {
        ctx.save();
        ctx.beginPath(); hl.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
        ctx.fillStyle = th.hullFill; ctx.fill();
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4; ctx.strokeStyle = th.hullCase; ctx.stroke();
        ctx.lineWidth = 2; ctx.strokeStyle = th.hull; ctx.stroke();
        ctx.restore();
      }
    }

    // 2) Recorrido del centro, hasta el instante actual
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const path = new Path2D();
    for (let k = 0; k <= f0; k++) {
      const x = proj.x(sim.center[k][1]), y = proj.y(sim.center[k][0]);
      if (k === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    const cLat = sim.center[f0][0] + (sim.center[f1][0] - sim.center[f0][0]) * a;
    const cLon = sim.center[f0][1] + (sim.center[f1][1] - sim.center[f0][1]) * a;
    const cx = proj.x(cLon), cy = proj.y(cLat);
    path.lineTo(cx, cy);
    ctx.setLineDash([]); ctx.strokeStyle = th.pathCase; ctx.lineWidth = 4.5; ctx.stroke(path);
    ctx.setLineDash([7, 6]); ctx.strokeStyle = th.pathCore; ctx.lineWidth = 2.2; ctx.stroke(path);
    ctx.restore();

    // 3) Partículas y estelas (últimas TRAIL_HOURS horas), encima de la mancha
    if (S.showParticles) {
      const frStart = Math.max(0, fr - TRAIL_HOURS / sim.dtHours);
      if (fr > frStart) {
        const tx = [], ty = [], tl = new Float64Array(n), to = new Float64Array(n);
        for (let k = 0; k <= TRAIL_SAMPLES; k++) {          // k = 0: la más vieja; k = TRAIL_SAMPLES: ahora
          positionsAt(sim, frStart + (fr - frStart) * k / TRAIL_SAMPLES, tl, to);
          const x = new Float32Array(n), y = new Float32Array(n);
          for (let q = 0; q < n; q++) { x[q] = proj.x(to[q]); y[q] = proj.y(tl[q]); }
          tx.push(x); ty.push(y);
        }
        ctx.save();
        ctx.lineCap = 'round'; ctx.lineWidth = 1.6;
        for (let k = 0; k < TRAIL_SAMPLES; k++) {
          ctx.strokeStyle = `rgba(${th.trail},${(0.15 + 0.7 * (k + 1) / TRAIL_SAMPLES).toFixed(3)})`;
          ctx.beginPath();
          for (let q = 0; q < n; q++) {
            if (stat[q] === Motor.STATUS_OUT) continue;
            if (tx[k][q] === tx[k + 1][q] && ty[k][q] === ty[k + 1][q]) continue;
            ctx.moveTo(tx[k][q], ty[k][q]); ctx.lineTo(tx[k + 1][q], ty[k + 1][q]);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.save();
      ctx.beginPath();                                       // a la deriva: puntos pequeños y contrastantes
      for (let q = 0; q < n; q++) {
        if (stat[q] !== Motor.STATUS_OK) continue;
        ctx.moveTo(xs[q] + 2.3, ys[q]); ctx.arc(xs[q], ys[q], 2.3, 0, 6.2832);
      }
      ctx.fillStyle = th.dot; ctx.fill();
      ctx.lineWidth = 0.9; ctx.strokeStyle = th.dotCase; ctx.stroke();
      ctx.beginPath();                                       // varadas en costa: rojo
      for (let q = 0; q < n; q++) {
        if (stat[q] !== Motor.STATUS_LAND) continue;
        ctx.moveTo(xs[q] + 3.4, ys[q]); ctx.arc(xs[q], ys[q], 3.4, 0, 6.2832);
      }
      ctx.fillStyle = '#FF5C5C'; ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = th.strandCase; ctx.stroke();
      ctx.restore();
    }

    // 4) Centro de la mancha
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = th.crossCase;
    ctx.beginPath(); ctx.moveTo(cx - 7, cy); ctx.lineTo(cx + 7, cy); ctx.moveTo(cx, cy - 7); ctx.lineTo(cx, cy + 7); ctx.stroke();
    ctx.lineWidth = 1.6; ctx.strokeStyle = th.crossCore; ctx.stroke();
    ctx.restore();
  }

  /* ---------- ciclo de dibujo ---------- */
  let lastT = 0;
  p.draw = () => {
    const now = performance.now();
    const dt = Math.min((now - (lastT || now)) / 1000, 0.1);
    lastT = now;
    if (App.onFrame) App.onFrame(dt);

    p.clear();
    const f = S.field;
    if (!f) return;
    const ctx = p.drawingContext, W = p.width, H = p.height;
    const proj = makeProjector();
    const fr = App.getInterp();

    // Bordes de celda en píxeles enteros (sin costuras entre celdas vecinas)
    const rx = [], ry = [];
    for (let j = 0; j <= f.nlon; j++) rx.push(Math.round(proj.x(f.lon0 + (j - 0.5) * f.dlon)));
    for (let i = 0; i <= f.nlat; i++) ry.push(Math.round(proj.y(f.lat0 + (i - 0.5) * f.dlat)));

    if (S.showHeat) drawHeat(ctx, f, fr, rx, ry, W, H);
    if (S.showGrid) drawGrid(ctx, proj, W, H);
    if (S.showFlow) { stepFlow(f, proj, dt, W, H); drawFlow(ctx, proj); }
    if (S.showArrows) drawArrows(ctx, f, fr, proj, rx, ry, W, H);
    if (S.showCoast) drawCoast(ctx, proj);
    drawSpill(ctx, proj, W, H);

    const h = S.hover;
    if (h) {
      ctx.save();
      ctx.lineWidth = 2; ctx.strokeStyle = THEME[S.base].hover;
      ctx.strokeRect(rx[h.j] + 0.5, ry[h.i + 1] + 0.5, rx[h.j + 1] - rx[h.j], ry[h.i] - ry[h.i + 1]);
      ctx.restore();
    }
  };
});

/* El bucle solo corre si algo se mueve; si no, se redibuja bajo demanda. */
App.refreshLoop = () => {
  const p = App.p5;
  if (!p) return;
  const need = S.showFlow || S.playing;
  if (need && !looping) { p.loop(); looping = true; }
  if (!need && looping) { p.noLoop(); looping = false; p.redraw(); }
};
App.redraw = () => { if (App.p5 && !looping) App.p5.redraw(); };

map.on('move', () => App.redraw());
map.on('zoomstart', () => { host.style.opacity = 0; });          // oculta la capa durante la animación de zoom
map.on('zoomend', () => { host.style.opacity = 1; App.redraw(); });
map.on('resize', () => {
  if (!App.p5) return;
  App.p5.resizeCanvas(host.clientWidth, host.clientHeight);
  App.redraw();
});
