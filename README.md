# Simulador de trayectoria de hidrocarburos — arranque en VS Code

Lee el archivo real de SEMAR (`data/dirmarea.txt`), corre un motor
Lagrangiano sobre él y anima la trayectoria en un mapa Leaflet.

## Qué trae el archivo de SEMAR (y qué NO)
`dirmarea.txt` trae, en una rejilla de 94x51 celdas (paso 0.16°, de
15–23°N y 98–83°O) y 41 pasos de tiempo (cada 3 h, 0–120 h):
- `dirolavto`: dirección del oleaje de viento (°)
- `alturaolavto`: altura del oleaje de viento (m)
- `-9.99e+08` = sin dato (tierra) → se usa como máscara de costa

**No trae corrientes ni viento.** Mientras tanto, el viento se estima
desde el oleaje (Hs = 0.0246·U², mar desarrollado) y las corrientes
quedan en 0. Esto está en `utils/semar_reader.py` y es una aproximación
interina: hay que pedirle a SEMAR corrientes y viento reales.

## Supuestos a confirmar con SEMAR
1. Convención de dirección: se asume "de dónde viene" (`WAVE_DIR_CONVENTION`
   en `semar_reader.py`). Si es "hacia dónde va", cambiar a `"to"`.
2. `olavto` = oleaje generado por viento (no mar de fondo).
3. Tercer dato del encabezado (`01OCT2026 00 3`) = horas de pronóstico.
4. Difusión: random walk simple (placeholder hasta que el profesor
   entregue la fórmula browniana).

## Motor (`utils/motor.py`)
Advección (corriente + 3% del viento, deflectado 20° por Coriolis),
difusión, y varamiento al entrar a una celda sin dato. Paso de 1 h →
resultados horarios. Solo se puede simular dentro de la ventana de
tiempo del archivo (hoy 01–06 oct 2026).

## 1. Requisitos
- Python 3.10+ instalado
- VS Code con la extensión "Python" (Microsoft)

## 2. Abrir el proyecto
1. Descomprime/copia esta carpeta `golfo-sim` donde quieras.
2. En VS Code: `Archivo > Abrir carpeta...` y selecciona `golfo-sim`.

## 3. Crear el entorno virtual
Abre una terminal dentro de VS Code (`Terminal > Nueva terminal`) y corre:

```bash
python -m venv venv
```

Actívalo:
- Windows (PowerShell): `venv\Scripts\Activate.ps1`
- Mac/Linux: `source venv/bin/activate`

VS Code normalmente detecta el entorno y te pregunta si quieres usarlo
como intérprete del proyecto — di que sí (o selecciónalo con
`Ctrl+Shift+P` → "Python: Select Interpreter").

## 4. Instalar dependencias

```bash
pip install -r requirements.txt
```

## 5. Correr el servidor

```bash
python app.py
```

Abre tu navegador en **http://127.0.0.1:8000**. Debería cargar el mapa
con una trayectoria de ejemplo ya animada. Usa "Simular desde un punto"
y haz clic en el mar para correr el motor sobre el archivo de SEMAR.
(En el servidor puedes apuntar a otro archivo con la variable de entorno
`SEMAR_FILE`.)

## 6. Probar con tu propio archivo
Usa el botón "Subir TXT de SEMAR" en la página. Debe tener el formato:

```
fecha_hora, latitud, longitud
2026-11-01 08:00, 19.1500, -92.3000
```

Columnas extra (volumen, tipo de hidrocarburo, etc.) se leen pero por
ahora no se muestran en el popup — eso es fácil de agregar en
`static/js/app.js`.

## 7. Estructura del proyecto

```
golfo-sim/
├── app.py                  # Flask: rutas y API
├── requirements.txt
├── utils/
│   ├── semar_reader.py     # lector del dirmarea.txt real de SEMAR
│   ├── motor.py            # motor Lagrangiano
│   └── parser.py           # lector de TXT de trayectoria (fecha, lat, lon)
├── templates/index.html
├── static/ (css, js)
└── data/
    ├── dirmarea.txt        # archivo real de SEMAR
    └── sample_spill.txt    # trayectoria generada por el motor (ejemplo)
```
