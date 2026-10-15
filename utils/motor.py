"""
Motor de pronostico de trayectoria y dispersion de hidrocarburos
(modelo Lagrangiano de particulas).

Cada particula representa una fraccion de la mancha. En cada paso de tiempo dt:

    posicion(t + dt) = posicion(t) + DERIVA * dt + DIFUSION

1) DERIVA POR VIENTO. El archivo de SEMAR trae oleaje generado por viento: su direccion
   es la del viento y su altura Hs da la intensidad del viento (relacion empirica de mar
   completamente desarrollado, tipo Pierson-Moskowitz; el coeficiente esta por confirmar,
   ver PM_COEF en semar_reader.py):

        U = sqrt(Hs / 0.0246)                     [m/s]

   El hidrocarburo superficial se mueve en la direccion en que sopla el viento, con una
   fraccion de su velocidad (coeficiente de arrastre, 3 %):

        v = DRAG_COEF * U                         [m/s]

   No se usan corrientes marinas ni desviacion por Coriolis. Este coeficiente es el unico
   parametro fisico de la deriva; sin el la particula no tendria velocidad.

2) DIFUSION BROWNIANA (turbulencia horizontal). Paso aleatorio normal en cada eje:

        dx = N(0,1) * sqrt(2 * K * dt)            dy = N(0,1) * sqrt(2 * K * dt)

   que es la solucion de la ecuacion de Langevin  dX = v dt + sqrt(2K) dW  y reproduce la
   relacion de Einstein  Var(x) = 2 K t  (la nube crece como sqrt(t)).
   K = 10 m^2/s (100 000 cm^2/s) es el valor por defecto de NOAA GNOME.

3) VARAMIENTO. Si una particula entra a una celda sin dato (tierra), se detiene y se marca
   como "varada". Una particula que sale del dominio del archivo tambien se detiene.

Integracion: Euler explicito, paso dt (1 h por defecto). Las posiciones se convierten de
metros a grados con  dlat = dy / 111320  y  dlon = dx / (111320 * cos(lat)).
"""

import math
from datetime import timedelta

import numpy as np

from .semar_reader import STATUS_LAND, STATUS_OK, STATUS_OUT

DRAG_COEF = 0.03             # fraccion del viento con que se mueve el hidrocarburo
DEFAULT_DIFFUSIVITY = 10.0   # K, m^2/s
DEFAULT_PARTICLES = 200
MAX_PARTICLES = 1000
MAX_DIFFUSIVITY = 1000.0
MAX_DRAG = 0.10
M_PER_DEG = 111_320.0


class SimulationError(Exception):
    """Entrada invalida (punto en tierra, fuera de la ventana de tiempo, parametros fuera de rango...)."""


def simulate(field, start_lat, start_lon, start_time, duration_hours=120.0, dt_hours=1.0,
             n_particles=DEFAULT_PARTICLES, diffusivity=DEFAULT_DIFFUSIVITY,
             drag=DRAG_COEF, seed=None):
    """
    Simula n_particles liberadas en un punto. Devuelve un diccionario con, por cada
    instante: latitud, longitud y estado de cada particula
    (0 = a la deriva, 1 = varada en costa, 2 = fuera del dominio).
    """
    values = (start_lat, start_lon, duration_hours, dt_hours, diffusivity, drag)
    if not all(math.isfinite(v) for v in values):
        raise SimulationError("Hay un parámetro que no es un número válido.")
    n_particles = int(n_particles)
    if not 1 <= n_particles <= MAX_PARTICLES:
        raise SimulationError(f"El número de partículas debe estar entre 1 y {MAX_PARTICLES}.")
    if not 0 <= diffusivity <= MAX_DIFFUSIVITY:
        raise SimulationError(f"La difusión K debe estar entre 0 y {MAX_DIFFUSIVITY:g} m²/s.")
    if not 0 <= drag <= MAX_DRAG:
        raise SimulationError(f"El arrastre del viento debe estar entre 0 y {MAX_DRAG * 100:g} %.")
    if dt_hours <= 0 or duration_hours <= 0:
        raise SimulationError("La duración y el paso de tiempo deben ser positivos.")

    w_start, w_end = field.window
    if not (w_start <= start_time <= w_end):
        raise SimulationError(
            f"La hora de inicio debe estar dentro del pronóstico "
            f"({w_start:%Y-%m-%d %H:%M} a {w_end:%Y-%m-%d %H:%M})."
        )

    s0, wu0, wv0 = field.sample_many([start_lat], [start_lon], start_time)
    if s0[0] == STATUS_OUT:
        b = field.bounds()
        raise SimulationError(
            f"El punto está fuera del dominio del archivo "
            f"({b['lat_min']:g} a {b['lat_max']:g} °N, {abs(b['lon_max']):g} a {abs(b['lon_min']):g} °O)."
        )
    if s0[0] == STATUS_LAND:
        raise SimulationError("El punto inicial cae en tierra (celda sin dato en el archivo de SEMAR).")

    notes = []
    remaining_h = (w_end - start_time).total_seconds() / 3600.0
    hours = min(float(duration_hours), remaining_h)
    if hours < duration_hours - 1e-9:
        notes.append(
            f"Duración recortada a {hours:g} h: el pronóstico de SEMAR termina el {w_end:%Y-%m-%d %H:%M}."
        )
    steps = int(hours / dt_hours + 1e-9)
    if steps < 1:
        raise SimulationError("Después de esa hora el pronóstico no cubre ni un paso de tiempo.")

    rng = np.random.default_rng(seed)
    n = n_particles
    lat = np.full(n, float(start_lat))
    lon = np.full(n, float(start_lon))
    status = np.full(n, STATUS_OK, dtype=np.int8)
    wu = np.full(n, wu0[0])
    wv = np.full(n, wv0[0])

    dt_s = dt_hours * 3600.0
    sigma = math.sqrt(2.0 * diffusivity * dt_s)      # paso de difusion por eje, en metros

    t = start_time
    times = [t]
    f_lat, f_lon, f_status = [lat.copy()], [lon.copy()], [status.copy()]

    for _ in range(steps):
        idx = np.flatnonzero(status == STATUS_OK)
        if idx.size == 0:
            notes.append(
                f"La simulación se detuvo a las {(t - start_time).total_seconds() / 3600:g} h: "
                f"todas las partículas llegaron a costa o salieron del dominio."
            )
            break
        la = lat[idx]
        dx = drag * wu[idx] * dt_s + rng.normal(0.0, sigma, idx.size)
        dy = drag * wv[idx] * dt_s + rng.normal(0.0, sigma, idx.size)
        lat[idx] = la + dy / M_PER_DEG
        lon[idx] = lon[idx] + dx / (M_PER_DEG * np.cos(np.radians(la)))
        t = t + timedelta(hours=dt_hours)

        s, u_new, v_new = field.sample_many(lat[idx], lon[idx], t)
        status[idx] = s
        ok = s == STATUS_OK
        wu[idx[ok]] = u_new[ok]
        wv[idx[ok]] = v_new[ok]

        times.append(t)
        f_lat.append(lat.copy())
        f_lon.append(lon.copy())
        f_status.append(status.copy())

    return {
        "times": times,
        "lat": np.array(f_lat),
        "lon": np.array(f_lon),
        "status": np.array(f_status),
        "dt_hours": float(dt_hours),
        "n_particles": n,
        "notes": notes,
        "params": {
            "diffusivity": float(diffusivity),
            "drag_pct": float(drag) * 100.0,
            "duration_hours": float(hours),
        },
    }


def to_payload(result):
    """Convierte el resultado a un diccionario listo para JSON (posiciones a 4 decimales, ~11 m)."""
    lat = np.round(result["lat"], 4)
    lon = np.round(result["lon"], 4)
    status = result["status"]
    center = np.stack([np.round(result["lat"].mean(axis=1), 4), np.round(result["lon"].mean(axis=1), 4)], axis=1)
    return {
        "times": [t.isoformat(timespec="minutes") for t in result["times"]],
        "lat": lat.tolist(),
        "lon": lon.tolist(),
        "status": status.tolist(),
        "center": center.tolist(),
        "stranded": (status == STATUS_LAND).sum(axis=1).tolist(),
        "lost": (status == STATUS_OUT).sum(axis=1).tolist(),
        "n_particles": result["n_particles"],
        "dt_hours": result["dt_hours"],
        "params": result["params"],
        "notes": result["notes"],
    }
