# Simulador de trayectoria de hidrocarburos — Sonda de Campeche

Aplicación web (Flask + Leaflet) que lee el pronóstico de oleaje de SEMAR, simula con un modelo
Lagrangiano hacia dónde se movería un derrame y lo anima sobre el mapa.

## 1. Cómo correrlo (VS Code, Windows)

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Abre **http://127.0.0.1:8000**. Al abrir la página corre una simulación de demostración desde
19.15 °N, 92.30 °O.

Pruebas automáticas (31): `python -m unittest discover -s tests -v`

Variables de entorno opcionales:

| Variable | Para qué | Por defecto |
|---|---|---|
| `SEMAR_DIR` | Carpeta donde está (y se va actualizando) el TXT de SEMAR | carpeta `data` |
| `PORT` | Puerto del servidor | `8000` |
| `FLASK_DEBUG` | `0` apaga el modo debug (obligatorio en producción) | `1` |

En PowerShell: `$env:SEMAR_DIR = "C:\ruta\a\la\carpeta"` y luego `python app.py`.

## 2. El archivo de SEMAR

```
LON;LAT;dirolavto;alturaolavto
01OCT2026 00 3              <- fecha de la corrida, hora de la corrida, horas de pronóstico
-98;23.;-9.99e+08;-9.99e+08
-97.84;23.;-9.99e+08;-9.99e+08
...
```

- **Fecha:** `01OCT2026 00 3` = corrida del 1 de octubre de 2026 a las 00 h, con 3 h de pronóstico,
  o sea válido el 2026-10-01 03:00. Cada bloque trae su hora; el archivo cubre 0 a 120 h cada 3 h
  sobre una rejilla de 94 × 51 celdas (0.16°, unos 18 km). Las horas se muestran tal como vienen
  en el archivo (confirmar con SEMAR si son UTC).
- **`dirolavto`:** dirección del oleaje generado por viento. Como es oleaje de viento, es la
  **dirección del viento**, en convención meteorológica: *de dónde viene* (0° = norte, 90° = este).
- **`alturaolavto`:** altura significante del oleaje de viento, Hs (m).
- **`-9.99e+08`:** sin dato = tierra. Se usa como máscara de costa.
- El archivo **no trae corrientes**, y el modelo no las usa.

### Dos formas de leerlo

1. **Subir el archivo** desde la página (botón «Subir archivo»). Se guarda en la memoria del
   servidor, no en disco, y se usa hasta que elijas «Usar directorio».
2. **Directorio que se actualiza solo** (botón «Usar directorio», que es el modo por defecto).
   El servidor lee una carpeta donde el TXT se va actualizando cada 3, 6 o 12 h, sin volver a
   cargarlo:
   - toma el archivo con la **corrida más reciente** (la fecha y hora del encabezado; si hay
     empate, el modificado más tarde) y **ignora** cualquier `.txt` que no tenga el formato de SEMAR;
   - detecta cuándo el archivo se sobrescribe o llega uno nuevo, y lo vuelve a leer solo;
   - la página revisa la carpeta cada minuto y avisa «Llegó un pronóstico nuevo»; la ventana de
     fechas del selector «Inicio del derrame» se actualiza con la nueva corrida;
   - si el archivo todavía se está copiando (modificado hace menos de 5 s) o llega dañado o
     incompleto, **sigue usando el último archivo bueno** y lo avisa. Un bloque de tiempo
     incompleto se descarta, porque si no sus celdas faltantes se leerían como tierra.
   - La carpeta se fija en el servidor (`SEMAR_DIR`), no desde el navegador, para que nadie pueda
     hacer que el servidor lea rutas arbitrarias.

## 3. El modelo

Cada partícula representa una fracción de la mancha. En cada paso de tiempo Δt (1 h):

**x(t+Δt) = x(t) + v·Δt + ξ**

### Deriva por viento (sin corrientes)

```
U = sqrt(Hs / 0.0246)        viento estimado desde la altura del oleaje   [m/s]
v = 0.03 · U                 hacia donde sopla el viento                  [m/s]
```

La dirección es la de `dirolavto` (volteada 180° porque indica de dónde viene). No se usan
corrientes ni desviación por Coriolis. **El 3 % no se puede quitar del todo:** sin una fracción del
viento la partícula no tendría velocidad. Es el único parámetro físico de la deriva y se cambia
en la página («Parámetros del modelo») o en `DRAG_COEF` de `utils/motor.py`. Ejemplo: con
Hs = 1 m, U = 6.4 m/s y la partícula avanza 0.19 m/s, unos 16.5 km al día.

### Difusión browniana

```
Δx = N(0,1) · sqrt(2 · K · Δt)        Δy = N(0,1) · sqrt(2 · K · Δt)
```

**De dónde sale.** La turbulencia horizontal se modela como difusión (ley de Fick,
∂C/∂t = K ∇²C). Una nube de partículas que se mueve con pasos aleatorios independientes y normales
cumple la misma ecuación si la varianza de cada paso es 2KΔt. Equivale a la ecuación de Langevin
dX = v dt + √(2K) dW. Tras un tiempo t, la dispersión de la nube es σ² = 2Kt (relación de
Einstein): crece como √t. La prueba automática `test_difusion_browniana_varianza` comprueba que
el código cumple justo esa relación.

**Qué valor de K.** K es la difusividad turbulenta horizontal. Se usa **K = 10 m²/s**
(100 000 cm²/s), el valor por defecto de NOAA GNOME, que la documenta como razonable para océano
costero «típico». Con ese K, la nube tiene una desviación de unos 1.3 km por eje a las 24 h y de
unos 2.9 km a las 120 h. K no se puede deducir de primeros principios: en la práctica se ajusta
para reproducir la dispersión observada, y en pronósticos de respuesta se elige alto para no
subestimar la mancha. **Hay que calibrarlo con un caso real** (por ejemplo, Ixtoc I).

### Varamiento

Si una partícula entra a una celda sin dato (tierra), se detiene y se marca como «varada». No se
vuelve a mover (no hay reflotación). La costa es la del archivo: celdas de unos 18 km, así que el
varamiento ocurre en el borde de esas celdas, no sobre la línea de costa real. Una partícula que
sale del dominio del archivo también se detiene.

## 4. La interfaz

- **Panel izquierdo:** datos de SEMAR (archivo o directorio), derrame (latitud y longitud, fecha de
  inicio, duración, número de partículas, parámetros del modelo) y reproducción.
- **Panel derecho:**
  - *Mapa base:* normal (OpenStreetMap) o satélite (Esri World Imagery).
  - *Recorrido:* **línea** (trayectoria del centro de la mancha, con el tramo recorrido resaltado) o
    **partículas en movimiento** (rojas las varadas).
  - *Coordenadas:* del cursor, del punto de derrame y del centro de la mancha en el instante
    mostrado; en grados decimales o en grados, minutos y segundos; y una cuadrícula opcional.
- **Punto de derrame:** clic en el mapa, arrastrar el marcador o escribir las coordenadas.

## 5. API

| Ruta | Para qué |
|---|---|
| `GET /api/field-info?source=directorio\|archivo&field_id=…` | corrida, ventana de tiempo y dominio del archivo en uso |
| `POST /api/upload` | sube un TXT de SEMAR (máx. 50 MB) y devuelve `field_id` |
| `POST /api/simulate` | corre el motor: `lat`, `lon`, `start_time`, `duration_hours`, `n_particles` (máx. 1000), `diffusivity`, `drag_pct`, `source`, `field_id`, `seed` |

Los errores devuelven un mensaje claro (punto en tierra, fuera del dominio, fuera de la ventana de
tiempo, parámetros fuera de rango, archivo inválido).

## 6. Supuestos por confirmar con SEMAR

1. **Convención de dirección.** Se asume «de dónde viene», la del viento. Si fuera «hacia dónde va»,
   cambiar `WAVE_DIR_CONVENTION` a `"to"` en `utils/semar_reader.py`.
2. **Zona horaria** de las horas del encabezado (¿UTC?).
3. **Coeficiente Hs → viento (0.0246).** No se pudo confirmar contra la fuente original; la literatura
   da Hs ≈ 0.0214·U². La diferencia es de ~7 % en la velocidad, menor que la incertidumbre del
   arrastre. Está en `PM_COEF` (`utils/semar_reader.py`).
4. **Arrastre del 3 %.** Está dentro de lo que se usa en la práctica (1–3 % del viento en modelos de
   derrames; 2.3–6 % medido con boyas), pero debe calibrarse.
5. Cada cuántas horas llega una corrida nueva (3, 6 o 12) y si el archivo se sobrescribe con el
   mismo nombre o llega con nombre nuevo (el sistema soporta ambos).

## 7. Seguridad (lo ya hecho y lo pendiente)

- La carpeta de lectura solo se configura en el servidor; la página nunca recibe rutas del servidor.
- El archivo subido se valida y se guarda solo en memoria (máx. 50 MB, máx. 4 archivos).
- Todo texto que viene del servidor se inserta con `textContent` (sin HTML).
- Leaflet se sirve desde el propio proyecto (`static/vendor`), sin depender de un CDN.
- **Pendiente para producción:** correr con `FLASK_DEBUG=0` detrás de Nginx + Gunicorn con HTTPS,
  y configurar `frame-ancestors` si la Marina lo incrusta con iframe. Los mapas base de
  OpenStreetMap y Esri se piden directo a sus servidores públicos: revisar sus términos de uso
  para producción.

## 8. Estructura

```
golfo-sim/
├── app.py                  # Flask: rutas y API
├── requirements.txt
├── utils/
│   ├── semar_reader.py     # lector del TXT de SEMAR (fecha de la corrida, máscara de tierra)
│   ├── fuentes.py          # directorio que se actualiza solo y archivos subidos
│   └── motor.py            # motor Lagrangiano de partículas
├── templates/index.html
├── static/ (css, js, vendor/leaflet)
├── data/                   # carpeta de lectura por defecto: aquí va el dirmarea.txt
└── tests/test_sistema.py   # 31 pruebas automáticas
```

## 9. Referencias

- NOAA, *GNOME — Trajectory Modeling*: https://gnome.orr.noaa.gov/doc/transport.html
- *Horizontal transport in oil-spill modeling* (arXiv:2009.12954): https://arxiv.org/pdf/2009.12954
