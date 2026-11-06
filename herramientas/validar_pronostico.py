#!/usr/bin/env python3
"""
Valida un archivo dirmarea.txt de SEMAR ANTES de publicarlo.
Usa solo la biblioteca estándar de Python (no hay que instalar nada).

Uso:    python3 herramientas/validar_pronostico.py data/dirmarea.txt
Salida: resumen del archivo y, si algo está mal, la lista de errores.
Código de salida: 0 = listo para publicar, 1 = NO publicar, 2 = no se pudo leer.
"""
import re
import sys
from datetime import datetime, timedelta

COLUMNAS = ["lon", "lat", "dirolavto", "alturaolavto"]
SIN_DATO = -1e8                      # cualquier valor menor significa "sin dato" (tierra)
MESES = {"JAN": 1, "ENE": 1, "FEB": 2, "MAR": 3, "APR": 4, "ABR": 4, "MAY": 5, "JUN": 6,
         "JUL": 7, "AUG": 8, "AGO": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12, "DIC": 12}
ENCABEZADO = re.compile(r"^(\d{1,2})([A-Za-z]{3})(\d{4})\s+(\d{1,2})\s+(\d+)\s*$")


def validar(ruta):
    errores, avisos = [], []
    try:
        with open(ruta, "rb") as f:
            lineas = f.read().decode("utf-8", errors="replace").splitlines()
    except OSError as e:
        print(f"No se pudo abrir {ruta}: {e}")
        return None

    if not lineas:
        return ["El archivo está vacío."], [], {}
    cols = [c.strip().lower() for c in lineas[0].split(";")]
    faltan = [c for c in COLUMNAS if c not in cols]
    if faltan:
        return [f"Encabezado de columnas inesperado; faltan: {', '.join(faltan)} "
                f"(se esperaba LON;LAT;dirolavto;alturaolavto)."], [], {}
    idx = [cols.index(c) for c in COLUMNAS]

    bloques, actual = [], None
    for n, linea in enumerate(lineas[1:], start=2):
        s = linea.strip()
        if not s:
            continue
        m = ENCABEZADO.match(s)
        if m:
            dia, mes, anio, hh, horas = m.groups()
            if mes.upper() not in MESES:
                errores.append(f"línea {n}: mes desconocido «{mes}» en el encabezado de tiempo.")
                actual = None
                continue
            corrida = datetime(int(anio), MESES[mes.upper()], int(dia), int(hh))
            actual = {"corrida": corrida, "valido": corrida + timedelta(hours=int(horas)),
                      "filas": []}
            bloques.append(actual)
            continue
        if actual is None:
            errores.append(f"línea {n}: hay datos antes de un encabezado de tiempo.")
            continue
        partes = s.split(";")
        if len(partes) != len(cols):
            errores.append(f"línea {n}: número de columnas incorrecto.")
            continue
        try:
            actual["filas"].append(tuple(float(partes[i]) for i in idx))
        except ValueError:
            errores.append(f"línea {n}: valor no numérico.")

    bloques = [b for b in bloques if b["filas"]]
    if not bloques:
        return errores + ["No se encontró ningún bloque de tiempo con datos."], avisos, {}

    ref = max(bloques, key=lambda b: len(b["filas"]))
    lons = sorted({round(f[0], 4) for f in ref["filas"]})
    lats = sorted({round(f[1], 4) for f in ref["filas"]})
    esperado = len(lons) * len(lats)
    if len(ref["filas"]) != esperado:
        errores.append("La rejilla no es regular (hay puntos repetidos o faltantes).")

    completos = []
    for b in bloques:
        if len(b["filas"]) != esperado:
            errores.append(f"El bloque válido el {b['valido']:%Y-%m-%d %H:%M} tiene "
                           f"{len(b['filas'])} de {esperado} puntos (¿archivo incompleto o copiándose?).")
        else:
            completos.append(b)
    if len(completos) < 2:
        errores.append(f"Solo hay {len(completos)} paso(s) de tiempo completo(s); se necesitan al menos 2.")

    tiempos = [b["valido"] for b in completos]
    if tiempos != sorted(set(tiempos)):
        errores.append("Los tiempos de pronóstico están repetidos o desordenados.")
    pasos = {int((b - a).total_seconds() // 3600) for a, b in zip(tiempos, tiempos[1:])}
    if len(pasos) > 1:
        avisos.append(f"El intervalo entre bloques no es constante: {sorted(pasos)} h.")
    if len({b["corrida"] for b in completos}) > 1:
        avisos.append("El archivo mezcla bloques de corridas distintas.")

    hs_max, tierra = 0.0, 0
    for b in completos[:1]:
        for _, _, d, h in b["filas"]:
            if d < SIN_DATO or h < SIN_DATO:
                tierra += 1
    for b in completos:
        for _, _, d, h in b["filas"]:
            if d < SIN_DATO or h < SIN_DATO:
                continue
            if not 0 <= d <= 360:
                avisos.append(f"Dirección fuera de 0–360° ({d}) en el bloque {b['valido']:%Y-%m-%d %H:%M}.")
                break
            hs_max = max(hs_max, h)
    if hs_max > 20:
        avisos.append(f"Altura de oleaje sospechosamente alta ({hs_max:.1f} m).")

    resumen = {}
    if completos:
        resumen = {
            "corrida": f"{completos[0]['corrida']:%Y-%m-%d %H:%M}",
            "ventana": f"{tiempos[0]:%Y-%m-%d %H:%M} a {tiempos[-1]:%Y-%m-%d %H:%M}",
            "bloques": f"{len(completos)} (cada {min(pasos) if pasos else '?'} h)",
            "rejilla": f"{len(lons)} x {len(lats)} celdas; lon {lons[0]} a {lons[-1]}, lat {lats[0]} a {lats[-1]}",
            "celdas sin dato (tierra)": f"{tierra} de {esperado} ({100 * tierra / esperado:.0f} %)",
            "Hs máxima": f"{hs_max:.2f} m",
        }
    return errores, avisos, resumen


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    r = validar(sys.argv[1])
    if r is None:
        return 2
    errores, avisos, resumen = r
    print(f"Archivo: {sys.argv[1]}")
    for k, v in resumen.items():
        print(f"  {k}: {v}")
    for a in avisos:
        print(f"  AVISO: {a}")
    if errores:
        print(f"\nRESULTADO: NO PUBLICAR ({len(errores)} error(es))")
        for e in errores[:10]:
            print(f"  - {e}")
        if len(errores) > 10:
            print(f"  ... y {len(errores) - 10} más")
        return 1
    print("\nRESULTADO: OK, listo para publicar")
    return 0


if __name__ == "__main__":
    sys.exit(main())
