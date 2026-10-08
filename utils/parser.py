"""
Lectura y validacion del archivo TXT que entrega SEMAR.

Se aisla en este modulo (ver seccion de riesgos del documento: "El formato
del TXT cambia") para que, si la Marina entrega un formato distinto, solo
haya que tocar esta funcion.

Formato esperado (una fila por punto de la trayectoria):
    fecha_hora, latitud, longitud
    2026-11-01 08:00, 19.1500, -92.3000
"""

import pandas as pd
import io


REQUIRED_COLUMNS = ["fecha_hora", "latitud", "longitud"]


class ParseError(Exception):
    """Error de validacion del archivo, con el numero de linea si se conoce."""
    pass


def parse_spill_file(file_bytes: bytes) -> dict:
    """
    Convierte el TXT crudo en la estructura que consume el frontend.

    Devuelve:
        {
          "points": [
             {"t": "2026-11-01T08:00:00", "lat": 19.15, "lon": -92.30, "extra": {...}},
             ...
          ],
          "warnings": ["linea 7: ..." , ...]
        }

    Lanza ParseError si el archivo no tiene las columnas minimas.
    """
    text = file_bytes.decode("utf-8", errors="replace")

    try:
        df = pd.read_csv(io.StringIO(text), skipinitialspace=True)
    except Exception as e:
        raise ParseError(f"No se pudo leer el archivo como CSV/TXT separado por comas: {e}")

    df.columns = [c.strip().lower() for c in df.columns]

    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ParseError(f"Faltan columnas obligatorias: {', '.join(missing)}")

    warnings = []
    points = []

    for idx, row in df.iterrows():
        line_no = idx + 2  # +1 por encabezado, +1 porque idx empieza en 0

        try:
            ts = pd.to_datetime(row["fecha_hora"])
        except Exception:
            warnings.append(f"linea {line_no}: fecha_hora invalida, se omite")
            continue

        try:
            lat = float(row["latitud"])
            lon = float(row["longitud"])
        except Exception:
            warnings.append(f"linea {line_no}: latitud/longitud invalida, se omite")
            continue

        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            warnings.append(f"linea {line_no}: coordenadas fuera de rango, se omite")
            continue

        extra = {
            c: row[c]
            for c in df.columns
            if c not in REQUIRED_COLUMNS and pd.notna(row[c])
        }

        points.append({
            "t": ts.isoformat(),
            "lat": lat,
            "lon": lon,
            "extra": extra,
        })

    points.sort(key=lambda p: p["t"])

    if not points:
        raise ParseError("El archivo no tiene ningun punto valido despues de la validacion")

    return {"points": points, "warnings": warnings}
