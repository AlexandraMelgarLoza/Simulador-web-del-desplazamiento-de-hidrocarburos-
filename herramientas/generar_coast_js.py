#!/usr/bin/env python3
"""
Genera data/coast.data.js a partir de data/coast.json.

El navegador no deja leer archivos con fetch cuando la página se abre con doble clic (file://),
pero sí deja cargar scripts con <script src>. Por eso la costa también se publica como un .js
que define window.COAST_DATA con el mismo contenido que coast.json.

Ejecutar cada vez que cambie data/coast.json.
Uso:    python3 herramientas/generar_coast_js.py        (en Windows: python herramientas/generar_coast_js.py)
Usa solo la biblioteca estándar de Python.
"""
import json
import os

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRADA = os.path.join(RAIZ, "data", "coast.json")
SALIDA = os.path.join(RAIZ, "data", "coast.data.js")


def main():
    with open(ENTRADA, encoding="utf-8") as f:
        datos = json.load(f)
    if "bbox" not in datos or "anillos" not in datos:
        raise SystemExit(f"{ENTRADA} no tiene las claves 'bbox' y 'anillos'.")
    cuerpo = json.dumps(datos, separators=(",", ":"))
    with open(SALIDA, "w", encoding="utf-8", newline="\n") as f:
        f.write("// Generado por herramientas/generar_coast_js.py a partir de data/coast.json. No editar a mano.\n")
        f.write("window.COAST_DATA = " + cuerpo + ";\n")
    print(f"Escrito {SALIDA} ({os.path.getsize(SALIDA) / 1024:.0f} KB, {len(datos['anillos'])} anillos)")


if __name__ == "__main__":
    main()
