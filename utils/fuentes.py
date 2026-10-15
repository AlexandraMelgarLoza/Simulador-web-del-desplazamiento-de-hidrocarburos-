"""
Fuentes de datos del campo de SEMAR. Hay dos formas de leer el TXT:

1) DIRECTORIO (DirectorySource): el servidor apunta a una carpeta donde el TXT se va
   actualizando solo (cada 3, 6 o 12 h). No hay que cargarlo otra vez:
     - se toma el archivo con la corrida mas reciente (fecha/hora del encabezado,
       p. ej. "01OCT2026 00 3"); si hay empate, el modificado mas tarde;
     - si el archivo cambia (se sobrescribe o llega uno nuevo), se vuelve a leer solo;
     - si el archivo aun se esta copiando o llega danado, se sigue usando el ultimo
       archivo bueno y se avisa.
   La carpeta se configura en el servidor con la variable de entorno SEMAR_DIR (no desde
   el navegador, para que nadie pueda hacer que el servidor lea rutas arbitrarias).

2) ARCHIVO SUBIDO (UploadStore): el usuario sube el TXT desde la pagina. Se guarda en
   memoria (no en disco) y la pagina lo pide por su identificador.
"""

import os
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime

from .semar_reader import SemarFormatError, load_semar_waves, peek_run_time

SETTLE_SECONDS = 5.0   # un archivo modificado hace menos de esto se considera "copiandose"


class SourceError(Exception):
    """No hay datos disponibles en la fuente elegida."""


class DirectorySource:
    def __init__(self, directory, settle_seconds=SETTLE_SECONDS):
        self.directory = os.path.abspath(directory)
        self.settle_seconds = settle_seconds
        self._label = os.path.basename(self.directory) or self.directory
        self._lock = threading.Lock()
        self._cache = None      # {"key", "name", "field"}
        self._failed = None     # (key, mensaje) del ultimo archivo que no se pudo leer

    def _candidates(self):
        try:
            entries = list(os.scandir(self.directory))
        except FileNotFoundError:
            raise SourceError(
                f"No existe la carpeta de lectura «{self._label}». "
                f"Configúrala con la variable de entorno SEMAR_DIR."
            )
        except OSError as e:
            raise SourceError(f"No se pudo abrir la carpeta de lectura «{self._label}»: {e.strerror or e}")
        found = []
        for e in entries:
            if not e.is_file() or not e.name.lower().endswith(".txt"):
                continue
            run = peek_run_time(e.path)
            if run is None:          # no es un archivo de SEMAR
                continue
            st = e.stat()
            found.append((run, st.st_mtime_ns, e.path, st.st_size))
        found.sort(reverse=True)     # corrida mas reciente; luego modificado mas tarde
        return found

    def _meta(self, cache, notice):
        return {
            "file": cache["name"],
            "directory": self._label,
            "modified": datetime.fromtimestamp(cache["key"][1] / 1e9).isoformat(timespec="seconds"),
            "notice": notice,
        }

    def get(self):
        """Devuelve (WaveField, meta). Lanza SourceError si no hay ningun archivo utilizable."""
        with self._lock:
            found = self._candidates()
            cache = self._cache

            if not found:
                if cache is not None:
                    return cache["field"], self._meta(
                        cache, "La carpeta quedó sin archivos de SEMAR; se sigue usando el último leído."
                    )
                raise SourceError(
                    f"No hay archivos de SEMAR (.txt) en la carpeta «{self._label}». "
                    f"Copia ahí el dirmarea.txt o sube el archivo desde la página."
                )

            run, mtime_ns, path, size = found[0]
            key = (path, mtime_ns, size)

            if cache is not None and cache["key"] == key:
                return cache["field"], self._meta(cache, None)

            if self._failed is not None and self._failed[0] == key:
                msg = self._failed[1]
                if cache is not None:
                    return cache["field"], self._meta(cache, f"{msg}. Se sigue usando {cache['name']}.")
                raise SourceError(msg)

            if cache is not None and time.time() - mtime_ns / 1e9 < self.settle_seconds:
                return cache["field"], self._meta(
                    cache, "Hay un archivo nuevo copiándose; se usa el anterior mientras termina."
                )

            name = os.path.basename(path)
            try:
                field = load_semar_waves(path)
            except (SemarFormatError, OSError) as e:
                msg = f"No se pudo leer {name}: {e}"
                self._failed = (key, msg)
                if cache is not None:
                    return cache["field"], self._meta(cache, f"{msg}. Se sigue usando {cache['name']}.")
                raise SourceError(msg)

            self._cache = {"key": key, "name": name, "field": field}
            self._failed = None
            return field, self._meta(self._cache, None)


class UploadStore:
    """Archivos subidos desde la pagina, en memoria (los mas viejos se descartan)."""

    def __init__(self, max_items=4):
        self.max_items = max_items
        self._items = OrderedDict()
        self._lock = threading.Lock()

    def put(self, field, name):
        field_id = uuid.uuid4().hex
        with self._lock:
            self._items[field_id] = {
                "field": field,
                "name": name,
                "uploaded": datetime.now().isoformat(timespec="seconds"),
            }
            while len(self._items) > self.max_items:
                self._items.popitem(last=False)
        return field_id

    def get(self, field_id):
        with self._lock:
            return self._items.get(field_id or "")
