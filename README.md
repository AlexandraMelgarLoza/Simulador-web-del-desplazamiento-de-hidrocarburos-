# Simulador de trayectoria de hidrocarburos — Sonda de Campeche

Mapa oscuro de Esri (Leaflet: oscuro / normal / satélite) + pronóstico de oleaje de SEMAR + simulación browniana de la mancha,
dibujada con p5.js. Son solo archivos estáticos: funciona con un servidor local, abriendo `index.html`
con doble clic, o alojado gratis (p. ej. GitHub Pages).

## Cómo abrirlo

### Con servidor local (carga `data/dirmarea.txt` automáticamente)
Windows (PowerShell o Símbolo del sistema):
```bat
cd C:\ruta\al\simulador
python servidor.py
```
Mac / Linux (Terminal):
```bash
cd /ruta/al/simulador
python3 servidor.py
```
Luego abre http://localhost:8000. Para detener el servidor, pulsa Ctrl + C.
Otro puerto: `python servidor.py 8080`. Para que se vea desde otra máquina (VPS): `python servidor.py 8000 0.0.0.0`.
`servidor.py` evita que el navegador guarde copias viejas. Si la página se ve sin estilos, recarga
forzando: Ctrl+F5 (Windows) o Cmd+Shift+R (Mac).

Los mosaicos del mapa (OpenStreetMap / Esri) y la fuente necesitan internet en ambas opciones.

## Uso
1. Haz clic en el mapa (o arrastra el marcador, o escribe las coordenadas) para colocar el derrame.
2. Ajusta inicio, duración y partículas. En **Parámetros del modelo browniano** están la difusión K,
   el **factor de deriva por oleaje** y la semilla. Pulsa **Simular**.
3. La barra de tiempo reproduce la mancha hora por hora (1, 2, 4 u 8 h por segundo) y se puede arrastrar.
   Usa Espacio para reproducir/pausar y las flechas izquierda/derecha para avanzar o retroceder una hora.
4. **Resultados** resume la distancia al origen, las partículas varadas y el primer varamiento, y muestra
   gráficas del área y de las partículas varadas. El detalle inferior muestra las partículas a la deriva,
   varadas y fuera del dominio, el área aproximada
   (km²) y el ancho máximo (km) de la envolvente de las partículas en el agua, el centro y la distancia
   al origen.
5. La leyenda flota sobre el mapa. El panel de mapa permite cambiar el mapa base y las capas:
   mancha (densidad), partículas y estelas
   (últimas 4 h), altura del oleaje, flechas de dirección de propagación de la ola, oleaje en
   movimiento, cuadrícula y línea de costa del modelo. Bajo el cursor se ven la altura de ola,
   su dirección y la velocidad de deriva estimada.

## Actualizar los datos
- Reemplaza `data/dirmarea.txt` y pulsa **Recargar datos**. Cada carga descarga el archivo sin caché.
- Antes de publicar un TXT nuevo, valídalo con `python herramientas/validar_pronostico.py data/dirmarea.txt`
  (en Mac: `python3`).
- Si cambia `data/coast.json`, regenera la versión para doble clic:
  `python herramientas/generar_coast_js.py`.

## Estructura
- `index.html`        página
- `servidor.py`       servidor local sin caché (opcional)
- `css/style.css`     estilos (tema oscuro y diseño responsive)
- `js/wavefield.js`   lector del TXT (por URL o por archivo elegido) y cálculo de la deriva de Stokes
- `js/coast.js`       costa fina: decide qué es tierra y qué es agua (prueba punto-en-polígono)
- `js/motor.js`       motor browniano: deriva por oleaje + difusión + varamiento; área y ancho de la mancha
- `js/sketch.js`      mapa y dibujo con p5.js (oleaje, cuadrícula, flujo, flechas, mancha, partículas)
- `js/ui.js`          controles, carga de datos, simulación, reproducción y lecturas
- `vendor/`           Leaflet 1.9.4 y p5.js 1.9.4 incluidos
- `herramientas/validar_pronostico.py` valida el TXT antes de publicarlo
- `herramientas/generar_coast_js.py`   genera `data/coast.data.js` a partir de `data/coast.json`
- `data/dirmarea.txt` pronóstico de oleaje de SEMAR (`LON;LAT;dirolavto;alturaolavto`)
- `data/coast.json`   contorno de costa (Natural Earth 1:10m, dominio público), 56 KB
- `data/coast.data.js` el mismo contorno como script (`window.COAST_DATA`), para abrir con doble clic

## Modelo: deriva por oleaje + difusión browniana
El motor integra la **deriva por oleaje** (deriva de Stokes) y la difusión aleatoria, con varamiento
costero. **No se usa el viento** ni se modela la corriente marina.

En cada paso de tiempo dt (1 h), para cada partícula (integración de Euler-Maruyama):

    x(t+dt) = x(t) + factor · Us · (dirección de propagación) · dt + N(0, σ),   σ = sqrt(2·K·dt)

Los metros se pasan a grados con dlat = dy / 111 320 y dlon = dx / (111 320·cos lat).
El oleaje se interpola linealmente en el tiempo entre los pasos del pronóstico (cada 3 h). En el
espacio se usa la celda más cercana.

**Deriva de Stokes.** El archivo de SEMAR trae la altura significante `alturaolavto` (Hs, m) y la
dirección de donde viene la ola `dirolavto` (°), pero no el periodo. Por eso:

1. Periodo estimado para mar desarrollado: `T ≈ 3.86·√Hs` (s).
2. Deriva de Stokes en superficie, ola lineal en aguas profundas (amplitud a = Hs/2,
   k = 4π²/(gT²), ω = 2π/T):  `Us = ω·k·a² = 2·π³·Hs² / (g·T³)`.
3. Sustituyendo T: `Us = 2π³ / (g·3.86³) · √Hs ≈ 0.11·√Hs` m/s. Por ejemplo, Hs = 1 m da 0.11 m/s
   (≈ 9.5 km/día) y Hs = 2 m da 0.16 m/s.

La deriva va en la **dirección de propagación** de la ola, opuesta a `dirolavto`.
El **factor de deriva por oleaje** (1.0 por defecto) multiplica Us para calibrar el modelo.

**Difusión browniana.** K = 10 m²/s por defecto (valor de NOAA GNOME). Con K = 0 todas las
partículas siguen la misma trayectoria (solo deriva). La **semilla** permite repetir una simulación.

**Varamiento.** Con la costa fina, una partícula cuyo paso termina en tierra, o cuyo punto medio
cae en tierra, se queda en su última posición en el agua y cuenta como "varada". Si sale del
dominio del archivo, se detiene y cuenta como "fuera del dominio".

**Tamaño de la mancha.** En el mapa, cada partícula representa un círculo de 1 km de radio en el
terreno (`PARTICLE_RADIUS_M` en `sketch.js`). Se convierte a píxeles con la escala del mapa, así que
la mancha tiene tamaño real a cualquier zoom; abajo de 1.5 px se deja en 1.5 px solo para que se
vea. El área y el ancho que aparecen en "Estado de la mancha" se calculan con la envolvente convexa
de las partículas en el agua, no con esos círculos.

**Supuestos y límites.** La fórmula es para una ola monocromática con H = Hs. Una formulación
espectral daría una deriva algo menor, y el periodo real puede diferir del de mar desarrollado
(por ejemplo, con mar de fondo). Ambas cosas se pueden compensar con el factor.

## Costa fina (lagunas y bahías)
La rejilla de SEMAR (0.16° ≈ 18 km) marca como "tierra" toda celda sin dato, incluidas lagunas y bahías
(p. ej. la Laguna de Términos). Por eso se usa el contorno de `data/coast.data.js` (o `data/coast.json`):
- Una partícula queda varada solo si toca tierra de verdad (se queda en la orilla, en su última posición en el agua).
- En el agua costera sin dato de SEMAR se usa el oleaje de la celda con dato más cercana (hasta 4 celdas, ~70 km).
  Es un supuesto: el oleaje dentro de una laguna suele ser menor que en mar abierto. Confirmar con SEMAR.
- Límite: a escala 1:10M, lagunas o canales muy pequeños pueden aparecer como tierra. La capa
  "Línea de costa del modelo" (panel derecho) muestra exactamente qué contorno se está usando.
- Si la costa no carga, la página avisa y usa solo la rejilla: entrar a una celda sin dato cuenta como tierra.
