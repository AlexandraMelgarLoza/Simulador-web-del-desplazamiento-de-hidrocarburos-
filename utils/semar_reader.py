"""
Lector del archivo de SEMAR (dirmarea.txt).

Formato del archivo
-------------------
    LON;LAT;dirolavto;alturaolavto
    01OCT2026 00 3
    -98;23.;-9.99e+08;-9.99e+08
    -97.84;23.;-9.99e+08;-9.99e+08
    ...
    01OCT2026 00 6
    ...

* Encabezado de bloque ("01OCT2026 00 3"):
      fecha de la corrida (ddMMMaaaa) + hora de la corrida (HH) + horas de pronostico.
  La hora a la que es valido el bloque es  corrida + horas de pronostico.
  Ejemplo: "01OCT2026 00 3" -> valido el 2026-10-01 03:00.
  Cuando SEMAR publica una corrida nueva, la fecha/hora de este encabezado cambia
  (cada 3, 6 o 12 h segun el caso); por eso se usa para saber cual archivo es el mas reciente.
* dirolavto   : direccion (grados) del oleaje generado por viento. Como es oleaje de
                viento, es la direccion del viento: convencion meteorologica, "de donde
                viene" (0 = norte, 90 = este). Ver WAVE_DIR_CONVENTION.
* alturaolavto: altura significante del oleaje de viento, Hs (m).
* -9.99e+08   : sin dato = tierra. Se usa como mascara de costa.

El archivo NO trae corrientes. El modelo no las usa: solo la direccion y la altura
del oleaje de viento.
"""

import re
from datetime import datetime, timedelta

import numpy as np

REQUIRED_COLUMNS = ["lon", "lat", "dirolavto", "alturaolavto"]
FILL_THRESHOLD = -1e8          # cualquier valor menor se considera "sin dato"
WAVE_DIR_CONVENTION = "from"   # "from" (de donde viene, como el viento) o "to" (hacia donde va)
# Hs = PM_COEF * U^2: relacion empirica de mar completamente desarrollado (tipo Pierson-Moskowitz).
# OJO: este coeficiente no se pudo confirmar contra la fuente original. La literatura da
# Hs = 0.21*U^2/g = 0.0214*U^2 (con el viento a otra altura de referencia). Usar 0.0214 sube la
# velocidad del viento estimada ~7 %. Ver README, seccion "Supuestos por confirmar".
PM_COEF = 0.0246

STATUS_OK, STATUS_LAND, STATUS_OUT = 0, 1, 2

_MONTHS = {
    "JAN": 1, "ENE": 1, "FEB": 2, "MAR": 3, "APR": 4, "ABR": 4, "MAY": 5,
    "JUN": 6, "JUL": 7, "AUG": 8, "AGO": 8, "SEP": 9, "OCT": 10, "NOV": 11,
    "DEC": 12, "DIC": 12,
}
_HEADER_RE = re.compile(r"^(\d{1,2})([A-Za-z]{3})(\d{4})\s+(\d{1,2})\s+(\d+)\s*$")
_MAX_WARNINGS = 20


class SemarFormatError(Exception):
    """El archivo no tiene la estructura esperada."""


def _read_header(match):
    """Devuelve (hora de la corrida, horas de pronostico) de un encabezado de bloque."""
    day, mon, year, hh, lead = match.groups()
    mon_n = _MONTHS.get(mon.upper())
    if mon_n is None:
        raise SemarFormatError(f"mes desconocido '{mon}' en el encabezado de tiempo '{match.group(0)}'")
    try:
        run = datetime(int(year), mon_n, int(day), int(hh))
    except ValueError:
        raise SemarFormatError(f"fecha u hora invalida en el encabezado de tiempo '{match.group(0)}'")
    return run, int(lead)


def wind_from_waves(direction_deg, hs_m):
    """
    Estima el viento (componentes este y norte, m/s) a partir del oleaje de viento.
    Intensidad: U = sqrt(Hs / 0.0246). Direccion: la del oleaje.
    Con la convencion "from" el vector apunta hacia donde sopla el viento.
    """
    speed = np.sqrt(np.maximum(hs_m, 0.0) / PM_COEF)
    theta = np.radians(direction_deg)
    sign = -1.0 if WAVE_DIR_CONVENTION == "from" else 1.0
    return sign * speed * np.sin(theta), sign * speed * np.cos(theta)


class WaveField:
    """Campo de oleaje de viento en rejilla regular, con interpolacion en el tiempo."""

    def __init__(self, run_time, times, lat0, lon0, dlat, dlon, direction, hs, warnings):
        self.run_time = run_time
        self.times = times                      # datetimes validos, ordenados
        self.hours = np.array([(t - times[0]).total_seconds() / 3600.0 for t in times])
        self.lat0, self.lon0, self.dlat, self.dlon = lat0, lon0, dlat, dlon
        self.nlat, self.nlon = direction.shape[1], direction.shape[2]
        self.direction, self.hs = direction, hs
        self.warnings = warnings
        # Viento asociado al oleaje (NaN donde no hay dato = tierra)
        self.wu, self.wv = wind_from_waves(direction, hs)

    @property
    def window(self):
        return self.times[0], self.times[-1]

    @property
    def step_hours(self):
        return float(np.median(np.diff(self.hours)))

    def bounds(self):
        return {
            "lat_min": self.lat0,
            "lat_max": round(self.lat0 + self.dlat * (self.nlat - 1), 4),
            "lon_min": self.lon0,
            "lon_max": round(self.lon0 + self.dlon * (self.nlon - 1), 4),
        }

    def _time_weights(self, t):
        th = (t - self.times[0]).total_seconds() / 3600.0
        th = min(max(th, self.hours[0]), self.hours[-1])
        k1 = int(np.searchsorted(self.hours, th))
        k1 = min(max(k1, 1), len(self.hours) - 1)
        k0 = k1 - 1
        den = self.hours[k1] - self.hours[k0]
        w = 0.0 if den <= 0 else (th - self.hours[k0]) / den
        return k0, k1, float(w)

    def sample_many(self, lat, lon, t):
        """
        Viento asociado al oleaje en varios puntos y a la hora t (interpolado en el tiempo,
        celda mas cercana en el espacio).
        Devuelve (estado, wu, wv):
          estado: STATUS_OK, STATUS_LAND (celda sin dato) o STATUS_OUT (fuera del dominio)
          wu, wv: m/s hacia el este y hacia el norte (NaN si no hay dato)
        """
        lat = np.atleast_1d(np.asarray(lat, dtype=float))
        lon = np.atleast_1d(np.asarray(lon, dtype=float))
        i = np.rint((lat - self.lat0) / self.dlat).astype(int)
        j = np.rint((lon - self.lon0) / self.dlon).astype(int)
        inside = (i >= 0) & (i < self.nlat) & (j >= 0) & (j < self.nlon)
        ic = np.clip(i, 0, self.nlat - 1)
        jc = np.clip(j, 0, self.nlon - 1)
        k0, k1, w = self._time_weights(t)
        wu = (1.0 - w) * self.wu[k0, ic, jc] + w * self.wu[k1, ic, jc]
        wv = (1.0 - w) * self.wv[k0, ic, jc] + w * self.wv[k1, ic, jc]
        land = np.isnan(wu) | np.isnan(wv)
        status = np.where(~inside, STATUS_OUT, np.where(land, STATUS_LAND, STATUS_OK)).astype(np.int8)
        return status, wu, wv


def peek_run_time(path):
    """
    Lee solo las primeras lineas del archivo y devuelve la fecha/hora de la corrida,
    o None si no parece un archivo de SEMAR. Es barato: sirve para saber cual archivo
    de una carpeta es el mas reciente sin leerlos completos.
    """
    try:
        with open(path, "rb") as f:
            head = f.read(2048).decode("utf-8", errors="replace").splitlines()
    except OSError:
        return None
    if len(head) < 2:
        return None
    cols = [c.strip().lower() for c in head[0].split(";")]
    if not all(c in cols for c in REQUIRED_COLUMNS):
        return None
    for line in head[1:4]:
        m = _HEADER_RE.match(line.strip())
        if m:
            try:
                return _read_header(m)[0]
            except SemarFormatError:
                return None
    return None


def parse_semar_waves(raw: bytes) -> WaveField:
    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if not lines:
        raise SemarFormatError("El archivo está vacío.")

    cols = [c.strip().lower() for c in lines[0].split(";")]
    missing = [c for c in REQUIRED_COLUMNS if c not in cols]
    if missing:
        raise SemarFormatError(
            f"Encabezado inesperado; faltan las columnas {', '.join(missing)} "
            f"(se esperaba LON;LAT;dirolavto;alturaolavto)."
        )
    idx = [cols.index(c) for c in REQUIRED_COLUMNS]
    ncols = len(cols)

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
            run, lead = _read_header(m)
            cur = {"run": run, "valid": run + timedelta(hours=lead), "rows": []}
            blocks.append(cur)
            continue
        if cur is None:
            warn(f"línea {n}: dato antes de un encabezado de tiempo, se omite")
            continue
        parts = s.split(";")
        if len(parts) != ncols:
            warn(f"línea {n}: número de columnas incorrecto, se omite")
            continue
        try:
            cur["rows"].append(
                (float(parts[idx[0]]), float(parts[idx[1]]), float(parts[idx[2]]), float(parts[idx[3]]))
            )
        except ValueError:
            warn(f"línea {n}: valor no numérico, se omite")

    blocks = [b for b in blocks if b["rows"]]
    if not blocks:
        raise SemarFormatError("No se encontró ningún bloque de tiempo con datos.")

    # Geometria de la rejilla a partir del bloque mas completo
    ref = max(blocks, key=lambda b: len(b["rows"]))
    a = np.array(ref["rows"])
    lons = np.unique(np.round(a[:, 0], 4))
    lats = np.unique(np.round(a[:, 1], 4))
    if len(lons) < 2 or len(lats) < 2:
        raise SemarFormatError("La rejilla es demasiado pequeña.")
    nlon, nlat = len(lons), len(lats)
    expected = nlon * nlat
    if len(ref["rows"]) != expected:
        raise SemarFormatError("La rejilla no es regular (hay puntos repetidos o faltantes).")
    dlon = float((lons[-1] - lons[0]) / (nlon - 1))
    dlat = float((lats[-1] - lats[0]) / (nlat - 1))
    lon0, lat0 = float(lons[0]), float(lats[0])

    by_time = {}
    for b in blocks:
        if len(b["rows"]) != expected:
            # Un bloque incompleto (p. ej. archivo copiandose aun) se descarta: si no,
            # sus celdas faltantes se leerian como tierra.
            warn(
                f"Se omitió el bloque de {b['valid']:%Y-%m-%d %H:%M}: tiene {len(b['rows'])} "
                f"de {expected} puntos (¿el archivo se estaba escribiendo?)"
            )
            continue
        arr = np.array(b["rows"])
        j = np.rint((arr[:, 0] - lon0) / dlon).astype(int)
        i = np.rint((arr[:, 1] - lat0) / dlat).astype(int)
        ok = (i >= 0) & (i < nlat) & (j >= 0) & (j < nlon)
        d = np.full((nlat, nlon), np.nan)
        h = np.full((nlat, nlon), np.nan)
        d[i[ok], j[ok]] = arr[ok, 2]
        h[i[ok], j[ok]] = arr[ok, 3]
        bad = ~(d > FILL_THRESHOLD) | ~(h > FILL_THRESHOLD)   # sin dato (o NaN) = tierra
        d[bad] = np.nan
        h[bad] = np.nan
        by_time[b["valid"]] = (b["run"], d, h)

    if len(by_time) < 2:
        raise SemarFormatError(
            f"El archivo solo tiene {len(by_time)} paso(s) de tiempo completo(s); se necesitan al menos 2."
        )

    times = sorted(by_time)
    direction = np.stack([by_time[t][1] for t in times])
    hs = np.stack([by_time[t][2] for t in times])
    return WaveField(by_time[times[0]][0], times, lat0, lon0, dlat, dlon, direction, hs, warnings)


def load_semar_waves(path) -> WaveField:
    with open(path, "rb") as f:
        return parse_semar_waves(f.read())
