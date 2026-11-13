'use strict';
/*
 * Costa fina (Natural Earth 1:10m, dominio público) para decidir qué es tierra y qué es agua.
 *
 * La rejilla de SEMAR (0.16° ≈ 18 km) marca como "tierra" cualquier celda sin dato, y eso incluye
 * lagunas, bahías y estuarios (p. ej. la Laguna de Términos). Con este contorno una partícula
 * solo queda varada si toca tierra de verdad.
 *
 * isLand(lat, lon): regla par-impar (se lanza un rayo hacia el este y se cuentan los cruces con
 * los bordes de los anillos; los anillos interiores —lagunas— se cuentan solos). Los bordes se
 * indexan por franjas de latitud, así cada consulta revisa unos pocos bordes.
 */
(function (root) {
  const BAND = 0.02;   // alto de cada franja de latitud, en grados

  class Coast {
    constructor(json) {
      this.bbox = json.bbox;                 // [lonMin, latMin, lonMax, latMax]
      this.rings = json.anillos;
      this.source = json.fuente || '';
      this.latMin = this.bbox[1];
      this.nBands = Math.ceil((this.bbox[3] - this.bbox[1]) / BAND) + 1;
      this.bands = Array.from({ length: this.nBands }, () => []);
      for (const ring of this.rings) {
        for (let k = 0; k < ring.length - 1; k++) {
          const [x1, y1] = ring[k], [x2, y2] = ring[k + 1];
          if (y1 === y2) continue;           // los bordes horizontales no cruzan el rayo
          const b0 = Math.max(0, Math.floor((Math.min(y1, y2) - this.latMin) / BAND));
          const b1 = Math.min(this.nBands - 1, Math.floor((Math.max(y1, y2) - this.latMin) / BAND));
          for (let b = b0; b <= b1; b++) this.bands[b].push(x1, y1, x2, y2);
        }
      }
    }

    isLand(lat, lon) {
      const b = Math.floor((lat - this.latMin) / BAND);
      if (b < 0 || b >= this.nBands) return false;
      const e = this.bands[b];
      let inside = false;
      for (let q = 0; q < e.length; q += 4) {
        const x1 = e[q], y1 = e[q + 1], x2 = e[q + 2], y2 = e[q + 3];
        if ((y1 > lat) !== (y2 > lat) && lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
      }
      return inside;
    }
  }

  async function loadCoast(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo descargar ${url} (código ${res.status}).`);
    return new Coast(await res.json());
  }

  /* Costa incluida como script (data/coast.data.js define window.COAST_DATA): carga sin fetch,
     también con file://. Devuelve null si el script no se cargó. */
  function coastFromGlobal() {
    return root.COAST_DATA ? new Coast(root.COAST_DATA) : null;
  }

  const api = { Coast, loadCoast, coastFromGlobal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CoastData = api;
})(typeof window !== 'undefined' ? window : globalThis);
