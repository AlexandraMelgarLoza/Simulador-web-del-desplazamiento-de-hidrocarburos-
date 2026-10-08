"""
Lector del archivo real que entrega SEMAR (dirmarea.txt).

Formato observado:
    LON;LAT;dirolavto;alturaolavto
    01OCT2026 00 0          <- encabezado de bloque: fecha de corrida, hora de corrida, horas de pronostico
    -98;23.;-9.99e+08;-9.99e+08
    -97.84;23.;-9.99e+08;-9.99e+08
    -97.68;23.;116.25;0.84
    ...                     <- 4794 puntos (94 lon x 51 lat, paso 0.16 grados)
    01OCT2026 00 3
    ...

  - dirolavto   : direccion del oleaje generado por viento (grados)
  - alturaolavto: altura del oleaje generado por viento (metros)
  - -9.99e+08   : sin dato (tierra) -> se usa como mascara de costa

IMPORTANTE: este archivo NO trae corrientes ni viento. Para poder mover la
mancha se estima el viento a partir del oleaje (ver wind_from_waves). Es una
aproximacion interina: cuando SEMAR entregue corrientes y viento reales, solo
hay que reemplazar la construccion de self.wu / self.wv.

Supuestos a confirmar con SEMAR:
  1. Convencion de direccion: se asume "de donde viene" (la habitual en
     modelos de oleaje). Se controla con WAVE_DIR_CONVENTION.
  2. "olavto" = oleaje de viento (mar local), no mar de fondo.
  3. Tercer dato del encabezado = horas de pronostico desde la corrida.
"""

import re
import math
from datetime import datetime, timedelta

import numpy as np

FILL_THRESHOLD = -1e8          # cualquier valor menor se considera "sin dato"
WAVE_DIR_CONVENTION = "from"   # "from" (de donde viene) o "to" (hacia donde va)
PM_COEF = 0.0246               # Hs = 0.0246 * U^2  (mar completamente desarrollado, Pierson-Moskowitz)

_MONTHS = {
    "JAN": 1, "ENE": 1, "FEB": 2, "MAR": 3, "APR": 4, "ABR": 4, "MAY": 5,
    "JUN": 6, "JUL": 7, "AUG": 8, "AGO": 8, "SEP": 9, "OCT": 10, "NOV": 11,
    "DEC": 12, "DIC": 12,
}
_HEADER_RE = re.compile(r"^(\d{1,2})([A-Za-z]{3})(\d{4})\s+(\d{1,2})\s+(\d+)\s*$")
_MAX_WARNINGS = 20


class SemarFormatError(Exception):
    """El archivo no tiene la estructura esperada."""


def wind_from_waves(direction_deg, hs_m):
    """
    Estima el viento (componentes este/norte, m/s) a partir del oleaje de viento.
    Velocidad: U = sqrt(Hs / 0.0246). Direccion: la del oleaje.
    """
    speed = np.sqrt(np.maximum(hs_m, 0.0) / PM_COEF)
    theta = np.radians(direction_deg)
    sign = -1.0 if WAVE_DIR_CONVENTION == "from" else 1.0
    wu = sign * speed * np.sin(theta)
    wv = sign * speed * np.cos(theta)
    return wu, wv


class WaveField:
    """Campo meteo-oceanico en rejilla regular, con interpolacion en el tiempo."""

    def __init__(self, run_time, times, lat0, lon0, dlat, dlon, direction, hs, warnings):
        self.run_time = run_time
        self.times = times                      # lista de datetime validos
        self.hours = np.array([(t - times[0]).total_seconds() / 3600.0 for t in times])
        self.lat0, self.lon0, self.dlat, self.dlon = lat0, lon0, dlat, dlon
        self.nlat, self.nlon = direction.shape[1], direction.shape[2]
        self.direction, self.hs = direction, hs
        self.warnings = warnings
        # Viento estimado (NaN donde no hay dato = tierra)
        self.wu, self.wv = wind_from_waves(direction, hs)

    @property
    def window(self):
        return self.times[0], self.times[-1]

    def bounds(self):
        return {
            "lat_min": self.lat0, "lat_max": self.lat0 + self.dlat * (self.nlat - 1),
            "lon_min": self.lon0, "lon_max": self.lon0 + self.dlon * (self.nlon - 1),
        }

    def sample(self, lat, lon, t):
        """
        Devuelve {"status": "ok"|"tierra"|"fuera_dominio", "wu":..., "wv":..., "cu":0, "cv":0}.
        Corrientes en 0 hasta que SEMAR las entregue.
        """
        i = int(round((lat - self.lat0) / self.dlat))
        j = int(round((lon - self.lon0) / self.dlon))
        if not (0 <= i < self.nlat and 0 <= j < self.nlon):
            return {"status": "fuera_dominio"}

        th = (t - self.times[0]).total_seconds() / 3600.0
        th = min(max(th, self.hours[0]), self.hours[-1])
        n = len(self.hours)
        if n == 1:
            k0 = k1 = 0
            w = 0.0
        else:
            k1 = int(np.searchsorted(self.hours, th))
            k1 = min(max(k1, 1), n - 1)
            k0 = k1 - 1
            w = (th - self.hours[k0]) / (self.hours[k1] - self.hours[k0])

        u0, u1 = self.wu[k0, i, j], self.wu[k1, i, j]
        v0, v1 = self.wv[k0, i, j], self.wv[k1, i, j]
        if np.isnan(u0) or np.isnan(u1):
            return {"status": "tierra"}

        return {
            "status": "ok",
            "wu": float(u0 + w * (u1 - u0)),
            "wv": float(v0 + w * (v1 - v0)),
            "cu": 0.0,
            "cv": 0.0,
        }


def parse_semar_waves(raw: bytes) -> WaveField:
    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if not lines:
        raise SemarFormatError("El archivo esta vacio")

    cols = [c.strip().lower() for c in lines[0].strip().split(";")]
    needed = ["lon", "lat", "dirolavto", "alturaolavto"]
    missing = [c for c in needed if c not in cols]
    if missing:
        raise SemarFormatError(
            f"Encabezado inesperado. Faltan columnas: {', '.join(missing)} "
            f"(se esperaba LON;LAT;dirolavto;alturaolavto)"
        )
    idx = {c: cols.index(c) for c in needed}

    warnings = []

    def warn(msg):
        if len(warnings) < _MAX_WARNINGS:
            warnings.append(msg)

    blocks = []
    cur = None
    for n, line in enumerate(lines[1:], start=2):
        s = line.strip()
        if not s:
            continue
        m = _HEADER_RE.match(s)
        if m:
            day, mon, year, hh, lead = m.groups()
            mon_n = _MONTHS.get(mon.upper())
            if mon_n is None:
                raise SemarFormatError(f"linea {n}: mes desconocido '{mon}'")
            run = datetime(int(year), mon_n, int(day), int(hh))
            cur = {"run": run, "valid": run + timedelta(hours=int(lead)), "rows": []}
            blocks.append(cur)
            continue
        if cur is None:
            warn(f"linea {n}: dato antes de un encabezado de tiempo, se omite")
            continue
        parts = s.split(";")
        if len(parts) != len(cols):
            warn(f"linea {n}: numero de columnas incorrecto, se omite")
            continue
        try:
            cur["rows"].append([float(parts[idx[c]]) for c in needed])
        except ValueError:
            warn(f"linea {n}: valor no numerico, se omite")

    blocks = [b for b in blocks if b["rows"]]
    if not blocks:
        raise SemarFormatError("No se encontro ningun bloque de tiempo con datos")

    # Geometria de la rejilla a partir del primer bloque
    first = np.array(blocks[0]["rows"])
    lons = np.unique(np.round(first[:, 0], 4))
    lats = np.unique(np.round(first[:, 1], 4))
    if len(lons) < 2 or len(lats) < 2:
        raise SemarFormatError("La rejilla del primer bloque es demasiado pequena")
    dlon = float((lons[-1] - lons[0]) / (len(lons) - 1))
    dlat = float((lats[-1] - lats[0]) / (len(lats) - 1))
    lon0, lat0 = float(lons[0]), float(lats[0])
    nlon, nlat = len(lons), len(lats)

    times, dirs, hss = [], [], []
    for b in blocks:
        a = np.array(b["rows"])
        if len(a) != nlon * nlat:
            warn(f"bloque {b['valid']:%d-%b-%Y %H:%M}: {len(a)} puntos (se esperaban {nlon * nlat})")
        j = np.rint((a[:, 0] - lon0) / dlon).astype(int)
        i = np.rint((a[:, 1] - lat0) / dlat).astype(int)
        ok = (i >= 0) & (i < nlat) & (j >= 0) & (j < nlon)
        d = np.full((nlat, nlon), np.nan)
        h = np.full((nlat, nlon), np.nan)
        d[i[ok], j[ok]] = a[ok, 2]
        h[i[ok], j[ok]] = a[ok, 3]
        bad = (d < FILL_THRESHOLD) | (h < FILL_THRESHOLD)
        d[bad] = np.nan
        h[bad] = np.nan
        times.append(b["valid"])
        dirs.append(d)
        hss.append(h)

    order = np.argsort(times)
    times = [times[k] for k in order]
    direction = np.stack([dirs[k] for k in order])
    hs = np.stack([hss[k] for k in order])

    return WaveField(blocks[0]["run"], times, lat0, lon0, dlat, dlon, direction, hs, warnings)


def load_semar_waves(path) -> WaveField:
    with open(path, "rb") as f:
        return parse_semar_waves(f.read())
