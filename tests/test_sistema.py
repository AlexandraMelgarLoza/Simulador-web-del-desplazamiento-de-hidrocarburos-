"""
Pruebas automaticas del lector, las fuentes de datos, el motor y la API.

Ejecutar desde la carpeta golfo-sim:
    python -m unittest discover -s tests -v

Las pruebas usan archivos SEMAR sinteticos pequenos (rejilla 5x5, oleaje del norte) para
poder comprobar a mano el resultado esperado. Una prueba extra usa data/dirmarea.txt si existe.
"""

import io
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import app as app_module                                         # noqa: E402
from utils import motor                                          # noqa: E402
from utils.fuentes import DirectorySource, SourceError          # noqa: E402
from utils.semar_reader import (                                 # noqa: E402
    STATUS_LAND, STATUS_OK, STATUS_OUT, SemarFormatError, parse_semar_waves, peek_run_time,
)

U_VIENTO = (1.0 / 0.0246) ** 0.5     # viento (m/s) para Hs = 1 m


def make_semar_text(run="01OCT2026 00", leads=range(0, 49, 3), land_below=18.3,
                    direction=0.0, hs=1.0, drop_last_rows=0):
    """Archivo SEMAR sintetico: lon -93..-92, lat 18..19 cada 0.25; tierra al sur de land_below."""
    lons = [round(-93 + 0.25 * i, 2) for i in range(5)]
    lats = [round(18 + 0.25 * i, 2) for i in range(5)]
    leads = list(leads)
    lines = ["LON;LAT;dirolavto;alturaolavto"]
    for n, lead in enumerate(leads):
        lines.append(f"{run} {lead}")
        rows = []
        # direction puede ser un numero o una lista con una direccion por bloque de tiempo
        dir_n = direction[n] if isinstance(direction, (list, tuple)) else direction
        for la in lats:
            for lo in lons:
                if la < land_below:
                    rows.append(f"{lo};{la};-9.99e+08;-9.99e+08")
                else:
                    rows.append(f"{lo};{la};{dir_n};{hs}")
        if drop_last_rows and n == len(leads) - 1:
            rows = rows[:-drop_last_rows]
        lines += rows
    return "\n".join(lines) + "\n"


def make_field(**kw):
    return parse_semar_waves(make_semar_text(**kw).encode())


class LectorTests(unittest.TestCase):
    def test_fecha_y_hora_de_validez(self):
        f = make_field(run="02OCT2026 12", leads=(0, 3, 6, 9))
        self.assertEqual(f.run_time, datetime(2026, 10, 2, 12))
        self.assertEqual(f.times[0], datetime(2026, 10, 2, 12))
        self.assertEqual(f.times[-1], datetime(2026, 10, 2, 21))      # 12 h + 9 h
        self.assertEqual(f.step_hours, 3.0)

    def test_mes_en_espanol_y_en_ingles(self):
        self.assertEqual(make_field(run="05ENE2027 06").run_time, datetime(2027, 1, 5, 6))
        self.assertEqual(make_field(run="05JAN2027 06").run_time, datetime(2027, 1, 5, 6))

    def test_peek_run_time(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.txt")
            with open(p, "w") as fh:
                fh.write(make_semar_text(run="03OCT2026 18"))
            self.assertEqual(peek_run_time(p), datetime(2026, 10, 3, 18))
            q = os.path.join(d, "otro.txt")
            with open(q, "w") as fh:
                fh.write("fecha_hora, latitud, longitud\n2026-10-01 08:00, 19.1, -92.3\n")
            self.assertIsNone(peek_run_time(q))

    def test_bloque_incompleto_se_descarta(self):
        f = make_field(leads=(0, 3, 6, 9), drop_last_rows=3)
        self.assertEqual(len(f.times), 3)
        self.assertTrue(any("omitió" in w for w in f.warnings))

    def test_un_solo_paso_de_tiempo_es_error(self):
        with self.assertRaises(SemarFormatError):
            make_field(leads=(0,))

    def test_encabezado_invalido(self):
        with self.assertRaises(SemarFormatError):
            parse_semar_waves(b"a;b;c\n1;2;3\n")

    def test_tierra_y_dominio(self):
        f = make_field()
        t = f.times[0]
        s, _, _ = f.sample_many([18.0, 18.75, 25.0], [-92.5, -92.5, -92.5], t)
        self.assertEqual(list(s), [STATUS_LAND, STATUS_OK, STATUS_OUT])

    def test_direccion_es_de_donde_viene(self):
        # Oleaje/viento del norte (0 grados): el viento sopla hacia el sur.
        s, wu, wv = make_field(direction=0.0).sample_many([18.75], [-92.5], datetime(2026, 10, 1))
        self.assertAlmostEqual(float(wu[0]), 0.0, places=6)
        self.assertAlmostEqual(float(wv[0]), -U_VIENTO, places=6)
        # Del este (90 grados): sopla hacia el oeste.
        s, wu, wv = make_field(direction=90.0).sample_many([18.75], [-92.5], datetime(2026, 10, 1))
        self.assertAlmostEqual(float(wu[0]), -U_VIENTO, places=6)
        self.assertAlmostEqual(float(wv[0]), 0.0, places=6)

    def test_interpolacion_entre_angulos_no_da_vueltas(self):
        # Viento del 350 al 10 (por el norte): a la mitad debe seguir siendo del norte (0 grados).
        # Si se promediaran los angulos (350+10)/2 = 180 saldria un viento del sur.
        f = make_field(leads=(0, 3), direction=[350.0, 10.0])
        _, wu, wv = f.sample_many([18.75], [-92.5], datetime(2026, 10, 1, 1, 30))
        self.assertAlmostEqual(float(wu[0]), 0.0, places=6)
        self.assertAlmostEqual(float(wv[0]), -U_VIENTO * np.cos(np.radians(10.0)), places=6)


class MotorTests(unittest.TestCase):
    def setUp(self):
        self.field = make_field(leads=range(0, 75, 3))
        self.t0 = self.field.times[0]

    def test_deriva_hacia_donde_sopla_el_viento(self):
        r = motor.simulate(self.field, 18.9, -92.5, self.t0, duration_hours=24, n_particles=5,
                           diffusivity=0.0, drag=0.03, seed=1)
        esperado = 0.03 * U_VIENTO * 24 * 3600 / 111_320.0          # grados hacia el sur
        self.assertAlmostEqual(18.9 - r["lat"][-1, 0], esperado, delta=1e-6)
        self.assertAlmostEqual(r["lon"][-1, 0], -92.5, places=9)
        self.assertEqual(len(r["times"]), 25)
        self.assertTrue(np.all(r["status"] == STATUS_OK))

    def test_sin_viento_arrastre_cero_no_hay_deriva(self):
        r = motor.simulate(self.field, 18.9, -92.5, self.t0, duration_hours=12, n_particles=3,
                           diffusivity=0.0, drag=0.0)
        self.assertTrue(np.allclose(r["lat"], 18.9))

    def test_varamiento(self):
        r = motor.simulate(self.field, 18.6, -92.5, self.t0, duration_hours=72, n_particles=10,
                           diffusivity=0.0, seed=1)
        self.assertTrue(np.all(r["status"][-1] == STATUS_LAND))
        self.assertLess(len(r["times"]), 73)                         # se detiene antes de las 72 h
        self.assertTrue(any("costa" in n for n in r["notes"]))
        # Entra a la celda de tierra (lat < 18.375) justo en el ultimo paso
        self.assertGreaterEqual(r["lat"][-2, 0], 18.375)
        self.assertLess(r["lat"][-1, 0], 18.375)

    def test_una_particula_varada_ya_no_se_mueve(self):
        r = motor.simulate(self.field, 18.5, -92.5, self.t0, duration_hours=72, n_particles=200,
                           diffusivity=50.0, seed=2)
        st = r["status"]
        varadas = np.flatnonzero((st == STATUS_LAND).any(axis=0))
        self.assertGreater(len(varadas), 0)
        for p in varadas[:50]:
            k = int(np.argmax(st[:, p] == STATUS_LAND))              # primer instante varada
            self.assertTrue(np.all(st[k:, p] == STATUS_LAND))
            self.assertTrue(np.all(r["lat"][k:, p] == r["lat"][k, p]))
            self.assertTrue(np.all(r["lon"][k:, p] == r["lon"][k, p]))

    def test_difusion_browniana_varianza(self):
        # Sin deriva: la dispersion debe cumplir Var(x) = 2 K t  (relacion de Einstein)
        K, horas, n = 10.0, 24, 5000
        r = motor.simulate(self.field, 18.9, -92.5, self.t0, duration_hours=horas, n_particles=1000,
                           diffusivity=K, drag=0.0, seed=7)
        n = r["n_particles"]
        dy = (r["lat"][-1] - 18.9) * 111_320.0
        dx = (r["lon"][-1] + 92.5) * 111_320.0 * np.cos(np.radians(18.9))
        esperado = (2 * K * horas * 3600) ** 0.5                     # ~1314 m
        self.assertAlmostEqual(float(dx.std()) / esperado, 1.0, delta=0.08)
        self.assertAlmostEqual(float(dy.std()) / esperado, 1.0, delta=0.08)
        self.assertLess(abs(float(dx.mean())), 4 * esperado / n ** 0.5)
        self.assertLess(abs(float(dy.mean())), 4 * esperado / n ** 0.5)

    def test_misma_semilla_misma_trayectoria(self):
        a = motor.simulate(self.field, 18.9, -92.5, self.t0, duration_hours=6, n_particles=20, seed=3)
        b = motor.simulate(self.field, 18.9, -92.5, self.t0, duration_hours=6, n_particles=20, seed=3)
        self.assertTrue(np.array_equal(a["lat"], b["lat"]))

    def test_duracion_se_recorta_a_la_ventana(self):
        t = self.t0 + timedelta(hours=48)
        r = motor.simulate(self.field, 18.9, -92.5, t, duration_hours=120, n_particles=5, seed=1)
        self.assertEqual(len(r["times"]), 25)                        # 24 h restantes
        self.assertTrue(any("recortada" in n for n in r["notes"]))

    def test_validaciones(self):
        f, t0 = self.field, self.t0
        with self.assertRaises(motor.SimulationError):
            motor.simulate(f, 18.0, -92.5, t0)                                   # tierra
        with self.assertRaises(motor.SimulationError):
            motor.simulate(f, 40.0, -92.5, t0)                                   # fuera del dominio
        with self.assertRaises(motor.SimulationError):
            motor.simulate(f, 18.9, -92.5, t0 - timedelta(hours=1))              # antes del pronostico
        with self.assertRaises(motor.SimulationError):
            motor.simulate(f, 18.9, -92.5, f.times[-1])                          # sin horas por delante
        for bad in (0, motor.MAX_PARTICLES + 1):
            with self.assertRaises(motor.SimulationError):
                motor.simulate(f, 18.9, -92.5, t0, n_particles=bad)
        with self.assertRaises(motor.SimulationError):
            motor.simulate(f, 18.9, -92.5, t0, diffusivity=-1)
        with self.assertRaises(motor.SimulationError):
            motor.simulate(f, float("nan"), -92.5, t0)


class FuenteDirectorioTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name, **kw):
        with open(os.path.join(self.dir, name), "w") as fh:
            fh.write(make_semar_text(**kw))

    def test_elige_la_corrida_mas_reciente_e_ignora_otros_txt(self):
        self.write("viejo.txt", run="01OCT2026 00")
        self.write("nuevo.txt", run="01OCT2026 06")
        with open(os.path.join(self.dir, "notas.txt"), "w") as fh:
            fh.write("esto no es un archivo de SEMAR\n")
        field, meta = DirectorySource(self.dir, settle_seconds=0).get()
        self.assertEqual(field.run_time, datetime(2026, 10, 1, 6))
        self.assertEqual(meta["file"], "nuevo.txt")

    def test_detecta_archivo_nuevo_sin_reiniciar(self):
        src = DirectorySource(self.dir, settle_seconds=0)
        self.write("dirmarea.txt", run="01OCT2026 00")
        self.assertEqual(src.get()[0].run_time, datetime(2026, 10, 1, 0))
        self.write("dirmarea_12.txt", run="01OCT2026 12")            # llega la corrida de las 12 h
        self.assertEqual(src.get()[0].run_time, datetime(2026, 10, 1, 12))

    def test_detecta_archivo_sobrescrito(self):
        src = DirectorySource(self.dir, settle_seconds=0)
        self.write("dirmarea.txt", run="01OCT2026 00", hs=1.0)
        a = src.get()[0]
        self.write("dirmarea.txt", run="01OCT2026 06", hs=2.0)       # mismo nombre, contenido nuevo
        b = src.get()[0]
        self.assertEqual(b.run_time, datetime(2026, 10, 1, 6))
        self.assertIsNot(a, b)

    def test_no_relee_si_no_cambio(self):
        src = DirectorySource(self.dir, settle_seconds=0)
        self.write("dirmarea.txt")
        self.assertIs(src.get()[0], src.get()[0])

    def test_archivo_danado_conserva_el_ultimo_bueno(self):
        src = DirectorySource(self.dir, settle_seconds=0)
        self.write("bueno.txt", run="01OCT2026 00")
        src.get()
        self.write("malo.txt", run="01OCT2026 06", leads=(0,))       # corrida mas nueva pero inutilizable
        field, meta = src.get()
        self.assertEqual(field.run_time, datetime(2026, 10, 1, 0))
        self.assertIn("No se pudo leer malo.txt", meta["notice"])

    def test_archivo_en_escritura_conserva_el_anterior(self):
        src = DirectorySource(self.dir, settle_seconds=3600)
        self.write("a.txt", run="01OCT2026 00")
        os.utime(os.path.join(self.dir, "a.txt"), (1, 1))            # el primero es "viejo"
        src.get()
        self.write("b.txt", run="01OCT2026 06")                      # recien escrito
        field, meta = src.get()
        self.assertEqual(field.run_time, datetime(2026, 10, 1, 0))
        self.assertIn("copiándose", meta["notice"])

    def test_carpeta_vacia_o_inexistente(self):
        with self.assertRaises(SourceError):
            DirectorySource(self.dir).get()
        with self.assertRaises(SourceError):
            DirectorySource(os.path.join(self.dir, "no_existe")).get()


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        with open(os.path.join(self.dir, "dirmarea.txt"), "w") as fh:
            fh.write(make_semar_text(leads=range(0, 75, 3)))
        self._old = app_module.directory
        app_module.directory = DirectorySource(self.dir, settle_seconds=0)
        self.c = app_module.app.test_client()

    def tearDown(self):
        app_module.directory = self._old
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_field_info(self):
        j = self.c.get("/api/field-info").get_json()
        self.assertEqual(j["run_time"], "2026-10-01T00:00")
        self.assertEqual(j["end_time"], "2026-10-04T00:00")
        self.assertEqual(j["step_hours"], 3.0)
        self.assertEqual(j["file"], "dirmarea.txt")
        self.assertNotIn(self.dir, str(j))                           # no se expone la ruta del servidor

    def test_simular_con_directorio(self):
        r = self.c.post("/api/simulate", json={"lat": 18.9, "lon": -92.5, "n_particles": 50,
                                               "duration_hours": 24, "seed": 1})
        j = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(j["n_particles"], 50)
        self.assertEqual(len(j["times"]), 25)
        self.assertEqual(len(j["lat"]), 25)
        self.assertEqual(len(j["lat"][0]), 50)
        self.assertEqual(len(j["center"]), 25)

    def test_errores_claros(self):
        casos = [
            ({"lat": 18.0, "lon": -92.5}, "tierra"),
            ({"lat": 40.0, "lon": -92.5}, "dominio"),
            ({"lat": 18.9, "lon": -92.5, "start_time": "2027-01-01T00:00"}, "pronóstico"),
            ({"lat": 18.9, "lon": -92.5, "start_time": "no es fecha"}, "hora de inicio"),
            ({"lat": 18.9, "lon": -92.5, "n_particles": 99999}, "partículas"),
            ({"lat": 18.9, "lon": -92.5, "n_particles": "abc"}, "n_particles"),
            ({"lat": "x", "lon": -92.5}, "latitud"),
        ]
        for body, texto in casos:
            r = self.c.post("/api/simulate", json=body)
            self.assertEqual(r.status_code, 400, body)
            self.assertIn(texto, r.get_json()["error"], body)

    def test_subir_archivo_y_simular_con_el(self):
        data = {"file": (io.BytesIO(make_semar_text(run="05OCT2026 06", leads=range(0, 75, 3)).encode()),
                         "mi_corrida.txt")}
        r = self.c.post("/api/upload", data=data, content_type="multipart/form-data")
        j = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(j["info"]["run_time"], "2026-10-05T06:00")
        self.assertEqual(j["info"]["file"], "mi_corrida.txt")
        sim = self.c.post("/api/simulate", json={"lat": 18.9, "lon": -92.5, "n_particles": 5, "seed": 1,
                                                 "source": "archivo", "field_id": j["field_id"],
                                                 "start_time": "2026-10-05T06:00"})
        self.assertEqual(sim.status_code, 200)
        self.assertEqual(sim.get_json()["field"]["run_time"], "2026-10-05T06:00")

    def test_subida_invalida(self):
        r = self.c.post("/api/upload", data={}, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)
        r = self.c.post("/api/upload", data={"file": (io.BytesIO(b"hola\nmundo\n"), "x.txt")},
                        content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)
        self.assertIn("formato de SEMAR", r.get_json()["error"])

    def test_archivo_subido_desconocido(self):
        r = self.c.post("/api/simulate", json={"lat": 18.9, "lon": -92.5, "source": "archivo", "field_id": "nada"})
        self.assertEqual(r.status_code, 404)


@unittest.skipUnless(os.path.exists(os.path.join(ROOT, "data", "dirmarea.txt")), "falta data/dirmarea.txt")
class ArchivoRealTests(unittest.TestCase):
    def test_dirmarea_real(self):
        from utils.semar_reader import load_semar_waves
        f = load_semar_waves(os.path.join(ROOT, "data", "dirmarea.txt"))
        self.assertEqual((f.nlat, f.nlon), (51, 94))
        self.assertEqual(len(f.times), 41)
        self.assertEqual(f.step_hours, 3.0)
        self.assertEqual(f.window[1] - f.window[0], timedelta(hours=120))
        r = motor.simulate(f, 19.15, -92.30, f.window[0], n_particles=100, seed=1)
        self.assertEqual(len(r["times"]), 121)


if __name__ == "__main__":
    unittest.main()
