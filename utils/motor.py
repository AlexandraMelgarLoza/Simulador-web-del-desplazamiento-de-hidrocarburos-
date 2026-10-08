"""
Motor de pronostico de trayectoria y dispersion (modelo Lagrangiano simplificado).

Consume un WaveField (utils/semar_reader.py), que entrega viento (estimado a
partir del oleaje) y corrientes (hoy en 0) sobre una rejilla con tiempo.

Fisica incluida:
  - Adveccion: velocidad = corriente + 3% del viento (deflectado ~20 grados a la
    derecha por Coriolis). Regla practica estandar en respuesta a derrames.
  - Difusion: random walk gaussiano, paso = sqrt(2*K*dt). PLACEHOLDER: el
    documento indica que la formula browniana final la entrega el profesor.
  - Varamiento: si la particula entra a una celda sin dato (tierra) se detiene
    y se marca "varado". Mascara de costa tomada del propio archivo de SEMAR
    (resolucion ~18 km; sin batimetria todavia).

Integracion: Euler con paso dt_hours (por defecto 1 h -> resultados horarios).
"""

import math
import random
from datetime import datetime, timedelta

WIND_DRIFT_FACTOR = 0.03
WIND_DEFLECTION_DEG = 20
DEFAULT_DIFFUSIVITY = 10.0  # m^2/s (placeholder)


class SimulationError(Exception):
    """Entrada invalida para la simulacion (punto en tierra, fuera de ventana, etc.)."""


def _meters_to_degrees(dx_m, dy_m, lat):
    dlat = dy_m / 111_320.0
    dlon = dx_m / (111_320.0 * math.cos(math.radians(lat)) + 1e-9)
    return dlat, dlon


def simulate(field, start_lat, start_lon, start_time: datetime,
             duration_hours=120, dt_hours=1.0,
             diffusivity=DEFAULT_DIFFUSIVITY, seed=None):
    """
    Devuelve (points, notes).
      points: [{"t": datetime, "lat", "lon", "status": "activo"|"varado"|"fuera_dominio",
                "wind_ms": float}, ...]
      notes:  avisos para mostrar al usuario (p.ej. duracion recortada)
    """
    w_start, w_end = field.window
    if not (w_start <= start_time <= w_end):
        raise SimulationError(
            f"La hora de inicio debe estar dentro de la ventana del pronostico "
            f"({w_start:%Y-%m-%d %H:%M} a {w_end:%Y-%m-%d %H:%M})"
        )

    s0 = field.sample(start_lat, start_lon, start_time)
    if s0["status"] == "fuera_dominio":
        b = field.bounds()
        raise SimulationError(
            f"El punto esta fuera del dominio del archivo "
            f"({b['lat_min']:g} a {b['lat_max']:g} N, {abs(b['lon_max']):g} a {abs(b['lon_min']):g} O)"
        )
    if s0["status"] == "tierra":
        raise SimulationError("El punto inicial cae en tierra (celda sin dato en el archivo de SEMAR)")

    notes = []
    end_time = start_time + timedelta(hours=duration_hours)
    if end_time > w_end:
        end_time = w_end
        notes.append(
            f"Duracion recortada a {(end_time - start_time).total_seconds() / 3600:.0f} h: "
            f"el pronostico de SEMAR termina el {w_end:%Y-%m-%d %H:%M}"
        )

    rng = random.Random(seed)
    lat, lon, t = start_lat, start_lon, start_time
    dt_s = dt_hours * 3600.0
    theta = math.radians(WIND_DEFLECTION_DEG)

    def wind_speed(s):
        return math.hypot(s["wu"], s["wv"])

    points = [{"t": t, "lat": lat, "lon": lon, "status": "activo", "wind_ms": wind_speed(s0)}]
    s = s0

    while t + timedelta(hours=dt_hours) <= end_time + timedelta(seconds=1):
        wu = s["wu"] * math.cos(theta) - s["wv"] * math.sin(theta)
        wv = s["wu"] * math.sin(theta) + s["wv"] * math.cos(theta)
        u = s["cu"] + WIND_DRIFT_FACTOR * wu
        v = s["cv"] + WIND_DRIFT_FACTOR * wv

        sigma = math.sqrt(2.0 * diffusivity * dt_s)
        dx = u * dt_s + rng.gauss(0, 1) * sigma
        dy = v * dt_s + rng.gauss(0, 1) * sigma

        dlat, dlon = _meters_to_degrees(dx, dy, lat)
        lat += dlat
        lon += dlon
        t += timedelta(hours=dt_hours)

        s_new = field.sample(lat, lon, t)
        if s_new["status"] == "ok":
            points.append({"t": t, "lat": lat, "lon": lon, "status": "activo",
                           "wind_ms": wind_speed(s_new)})
            s = s_new
        else:
            status = "varado" if s_new["status"] == "tierra" else "fuera_dominio"
            points.append({"t": t, "lat": lat, "lon": lon, "status": status, "wind_ms": 0.0})
            break

    return points, notes


def points_to_txt_rows(points):
    """Resultados horarios en el formato TXT que ya consume la app."""
    rows = ["fecha_hora, latitud, longitud, estado, viento_ms"]
    for p in points:
        rows.append(f"{p['t']:%Y-%m-%d %H:%M}, {p['lat']:.4f}, {p['lon']:.4f}, "
                    f"{p['status']}, {p['wind_ms']:.1f}")
    return rows


if __name__ == "__main__":
    # Uso directo:  python -m utils.motor
    # Corre el motor sobre data/dirmarea.txt y regenera data/sample_spill.txt
    import os
    from utils.semar_reader import load_semar_waves

    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    field = load_semar_waves(os.path.join(base, "data", "dirmarea.txt"))
    start = field.window[0]
    pts, notes = simulate(field, 19.15, -92.30, start, duration_hours=120, dt_hours=1, seed=42)

    out = os.path.join(base, "data", "sample_spill.txt")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(points_to_txt_rows(pts)) + "\n")
    print(f"{len(pts)} puntos escritos en {out}; estado final: {pts[-1]['status']}")
    for n in notes:
        print("Nota:", n)
