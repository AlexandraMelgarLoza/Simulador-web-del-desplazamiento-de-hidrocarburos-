#!/usr/bin/env python3
"""
Servidor del simulador. Igual que `python3 -m http.server`, pero le pide al navegador
que NO guarde copias de los archivos: así cada recarga (Cmd+R) trae siempre la versión y los
datos más recientes.

Uso:   python3 servidor.py                  (solo esta computadora, puerto 8000)
       python3 servidor.py 8080             (otro puerto)
       python3 servidor.py 8000 0.0.0.0     (visible desde internet: para un VPS)
Detener: Ctrl + C
"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
HOST = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"


class SinCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


os.chdir(os.path.dirname(os.path.abspath(__file__)))
with http.server.ThreadingHTTPServer((HOST, PORT), SinCache) as servidor:
    if HOST in ("127.0.0.1", "localhost"):
        print(f"Simulador en http://localhost:{PORT}   (Ctrl + C para detener)", flush=True)
    else:
        print(f"Simulador escuchando en el puerto {PORT} (todas las interfaces).", flush=True)
        print(f"Abrir desde el navegador: http://<IP del servidor>:{PORT}   (Ctrl + C para detener)", flush=True)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
