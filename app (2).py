"""
Servidor Flask del simulador de desplazamiento de hidrocarburos.

Rutas:
  GET  /                 -> pagina principal (mapa)
  GET  /api/field-info   -> metadatos del archivo de SEMAR (ventana de tiempo, dominio, avisos)
  GET  /api/sample       -> trayectoria de ejemplo (data/sample_spill.txt)
  POST /api/upload       -> sube un TXT de trayectoria (fecha_hora, latitud, longitud)
  POST /api/simulate     -> corre el motor Lagrangiano sobre el archivo de SEMAR

El archivo de SEMAR se lee de data/dirmarea.txt, o de la ruta en la variable
de entorno SEMAR_FILE (util en el servidor de produccion).
"""

import os
from datetime import datetime

from flask import Flask, render_template, jsonify, request

from utils.parser import parse_spill_file, ParseError
from utils.semar_reader import load_semar_waves, SemarFormatError
from utils import motor

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SAMPLE_PATH = os.path.join(BASE_DIR, "data", "sample_spill.txt")
SEMAR_PATH = os.environ.get("SEMAR_FILE", os.path.join(BASE_DIR, "data", "dirmarea.txt"))

_field_cache = {"mtime": None, "field": None}


def get_field():
    """Carga el archivo de SEMAR y lo guarda en memoria; recarga si el archivo cambia."""
    mtime = os.path.getmtime(SEMAR_PATH)
    if _field_cache["field"] is None or _field_cache["mtime"] != mtime:
        _field_cache["field"] = load_semar_waves(SEMAR_PATH)
        _field_cache["mtime"] = mtime
    return _field_cache["field"]


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/field-info")
def api_field_info():
    try:
        field = get_field()
    except FileNotFoundError:
        return jsonify({"error": f"No se encontro el archivo de SEMAR en {SEMAR_PATH}"}), 404
    except SemarFormatError as e:
        return jsonify({"error": str(e)}), 400

    start, end = field.window
    return jsonify({
        "run_time": field.run_time.isoformat(),
        "start_time": start.isoformat(timespec="minutes"),
        "end_time": end.isoformat(timespec="minutes"),
        "n_times": len(field.times),
        "bounds": field.bounds(),
        "warnings": field.warnings,
    })


@app.route("/api/sample")
def api_sample():
    with open(SAMPLE_PATH, "rb") as f:
        raw = f.read()
    try:
        return jsonify(parse_spill_file(raw))
    except ParseError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/upload", methods=["POST"])
def api_upload():
    if "file" not in request.files:
        return jsonify({"error": "No se recibio ningun archivo (campo 'file')"}), 400
    try:
        return jsonify(parse_spill_file(request.files["file"].read()))
    except ParseError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/simulate", methods=["POST"])
def api_simulate():
    """
    Body JSON: { "lat": 19.15, "lon": -92.30,
                 "start_time": "2026-10-01T00:00"   (opcional: por defecto el inicio del pronostico),
                 "duration_hours": 120, "dt_hours": 1 }
    """
    body = request.get_json(force=True, silent=True) or {}

    try:
        lat = float(body["lat"])
        lon = float(body["lon"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Se requieren 'lat' y 'lon' numericos"}), 400

    try:
        field = get_field()
    except FileNotFoundError:
        return jsonify({"error": f"No se encontro el archivo de SEMAR en {SEMAR_PATH}"}), 404
    except SemarFormatError as e:
        return jsonify({"error": str(e)}), 400

    try:
        start_time = (datetime.fromisoformat(body["start_time"])
                      if body.get("start_time") else field.window[0])
        duration_hours = float(body.get("duration_hours", 120))
        dt_hours = float(body.get("dt_hours", 1))
    except ValueError:
        return jsonify({"error": "start_time (formato ISO), duration_hours o dt_hours invalidos"}), 400

    if dt_hours <= 0 or duration_hours <= 0:
        return jsonify({"error": "duration_hours y dt_hours deben ser positivos"}), 400

    try:
        result, notes = motor.simulate(field, lat, lon, start_time,
                                       duration_hours=duration_hours, dt_hours=dt_hours)
    except motor.SimulationError as e:
        return jsonify({"error": str(e)}), 400

    points = [
        {"t": p["t"].isoformat(), "lat": p["lat"], "lon": p["lon"],
         "extra": {"estado": p["status"], "viento_ms": round(p["wind_ms"], 1)}}
        for p in result
    ]
    return jsonify({"points": points, "warnings": notes})


if __name__ == "__main__":
    # debug=True solo para desarrollo local
    app.run(debug=True, host="127.0.0.1", port=8000)
