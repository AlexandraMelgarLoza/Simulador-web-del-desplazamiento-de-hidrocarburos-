"""
Servidor Flask del simulador de desplazamiento de hidrocarburos.

Rutas:
  GET  /                 -> pagina principal (mapa)
  GET  /api/field-info   -> metadatos del archivo de SEMAR en uso (corrida, ventana de tiempo, dominio)
  POST /api/upload       -> sube un TXT de SEMAR (se guarda en memoria) y devuelve su identificador
  POST /api/simulate     -> corre el motor Lagrangiano con N particulas

Dos fuentes de datos (parametro "source"):
  "directorio" -> carpeta del servidor donde el TXT se va actualizando (variable SEMAR_DIR,
                  por defecto la carpeta data/). Se relee solo cuando llega un archivo nuevo.
  "archivo"    -> TXT subido desde la pagina (parametro "field_id").
"""

import os
from datetime import datetime

from flask import Flask, jsonify, render_template, request

from utils import motor
from utils.fuentes import DirectorySource, SourceError, UploadStore
from utils.semar_reader import SemarFormatError, parse_semar_waves

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SEMAR_DIR = os.environ.get("SEMAR_DIR", os.path.join(BASE_DIR, "data"))
MAX_UPLOAD_MB = 50

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

directory = DirectorySource(SEMAR_DIR)
uploads = UploadStore(max_items=4)


def resolve_field(source, field_id):
    """Devuelve (campo, meta) segun la fuente elegida."""
    if source == "archivo":
        item = uploads.get(field_id)
        if item is None:
            raise SourceError(
                "El archivo subido ya no está disponible en el servidor. "
                "Súbelo otra vez o usa el directorio."
            )
        return item["field"], {
            "file": item["name"], "directory": None, "modified": item["uploaded"], "notice": None,
        }
    return directory.get()


def build_info(field, meta, source):
    start, end = field.window
    return {
        "source": source,
        "file": meta.get("file"),
        "directory": meta.get("directory"),
        "modified": meta.get("modified"),
        "notice": meta.get("notice"),
        "run_time": field.run_time.isoformat(timespec="minutes"),
        "start_time": start.isoformat(timespec="minutes"),
        "end_time": end.isoformat(timespec="minutes"),
        "n_times": len(field.times),
        "step_hours": field.step_hours,
        "bounds": field.bounds(),
        "warnings": field.warnings,
        "checked_at": datetime.now().isoformat(timespec="seconds"),
    }


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": f"El archivo supera el límite de {MAX_UPLOAD_MB} MB."}), 413


@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/field-info")
def api_field_info():
    source = request.args.get("source", "directorio")
    try:
        field, meta = resolve_field(source, request.args.get("field_id"))
    except SourceError as e:
        return jsonify({"error": str(e)}), 404
    return jsonify(build_info(field, meta, source))


@app.post("/api/upload")
def api_upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"error": "No se recibió ningún archivo (campo 'file')."}), 400
    try:
        field = parse_semar_waves(f.read())
    except SemarFormatError as e:
        return jsonify({"error": f"El archivo no tiene el formato de SEMAR: {e}"}), 400
    name = os.path.basename(f.filename)[:80]
    field_id = uploads.put(field, name)
    meta = {"file": name, "directory": None, "modified": uploads.get(field_id)["uploaded"], "notice": None}
    return jsonify({"field_id": field_id, "info": build_info(field, meta, "archivo")})


def _num(body, key, default, kind=float):
    value = body.get(key, default)
    if value is None or value == "":
        value = default
    try:
        return kind(value)
    except (TypeError, ValueError):
        raise ValueError(f"El valor de «{key}» no es válido.")


@app.post("/api/simulate")
def api_simulate():
    """
    Body JSON:
      lat, lon            punto del derrame (grados; longitud negativa = oeste)
      start_time          "2026-10-01T00:00" (opcional; por defecto el inicio del pronostico)
      duration_hours      por defecto 120 (se recorta a lo que cubra el pronostico)
      n_particles         por defecto 200 (maximo 1000)
      diffusivity         K en m2/s (por defecto 10)
      drag_pct            arrastre del viento en % (por defecto 3)
      source, field_id    fuente de datos
      seed                opcional, para repetir exactamente una simulacion
    """
    body = request.get_json(silent=True) or {}

    try:
        lat = float(body["lat"])
        lon = float(body["lon"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Escribe una latitud y una longitud numéricas."}), 400

    source = body.get("source", "directorio")
    try:
        field, meta = resolve_field(source, body.get("field_id"))
    except SourceError as e:
        return jsonify({"error": str(e)}), 404

    try:
        raw_start = body.get("start_time")
        start_time = datetime.fromisoformat(raw_start) if raw_start else field.window[0]
        duration = _num(body, "duration_hours", 120)
        n_particles = _num(body, "n_particles", motor.DEFAULT_PARTICLES, int)
        diffusivity = _num(body, "diffusivity", motor.DEFAULT_DIFFUSIVITY)
        drag = _num(body, "drag_pct", motor.DRAG_COEF * 100.0) / 100.0
        seed = _num(body, "seed", None, int) if body.get("seed") not in (None, "") else None
    except ValueError as e:
        message = str(e) if "«" in str(e) else "La hora de inicio no es válida (usa AAAA-MM-DDTHH:MM)."
        return jsonify({"error": message}), 400

    try:
        result = motor.simulate(
            field, lat, lon, start_time, duration_hours=duration, dt_hours=1.0,
            n_particles=n_particles, diffusivity=diffusivity, drag=drag, seed=seed,
        )
    except motor.SimulationError as e:
        return jsonify({"error": str(e)}), 400

    payload = motor.to_payload(result)
    payload["field"] = {"file": meta.get("file"), "run_time": field.run_time.isoformat(timespec="minutes")}
    return jsonify(payload)


if __name__ == "__main__":
    # FLASK_DEBUG=0 para apagar el modo debug (obligatorio en produccion).
    app.run(
        debug=os.environ.get("FLASK_DEBUG", "1") == "1",
        host="127.0.0.1",
        port=int(os.environ.get("PORT", "8000")),
    )
