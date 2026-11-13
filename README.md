# Simulador de hidrocarburos — versión p5.js

<<<<<<< Updated upstream
Mapa (Leaflet: calles / satélite) + datos de SEMAR + simulación de la mancha, dibujados con p5.js.
Sin servidor y sin Python: son solo archivos estáticos (se pueden alojar gratis, p. ej. GitHub Pages).

## Correr en local (Mac)
=======
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
>>>>>>> Stashed changes
```bash
cd simulador-p5
python3 servidor.py
```
Abre http://localhost:8000 (no sirve abrir index.html con doble clic: el navegador bloquea la lectura del TXT).
`servidor.py` evita que el navegador guarde copias viejas de los archivos. Si la página se ve sin estilos, recarga con Cmd+Shift+R.

## Uso
<<<<<<< Updated upstream
1. Clic en el mapa (o arrastra el marcador, o escribe las coordenadas) para colocar el derrame.
2. Ajusta inicio, duración y partículas; pulsa **Simular**.
3. La barra de tiempo inferior reproduce la mancha hora por hora (1, 2, 4 u 8 h por segundo) y se puede arrastrar.
4. Panel derecho: mapa base, capas (oleaje, flechas, viento en movimiento, cuadrícula) y formato de coordenadas.

## Actualizar los datos
Reemplaza `data/dirmarea.txt` por el archivo nuevo y recarga la página (Cmd+R). Cada carga descarga el archivo sin usar caché.

## Estructura
- `index.html`        página
- `servidor.py`       servidor local sin caché (python3 servidor.py)
- `css/style.css`     estilos (tema marino claro)
- `js/wavefield.js`   lector del TXT (port de semar_reader.py)
=======
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
>>>>>>> Stashed changes
- `js/coast.js`       costa fina: decide qué es tierra y qué es agua (prueba punto-en-polígono)
- `js/motor.js`       motor browniano (port de motor.py): deriva por ola/viento + difusión + varamiento
- `js/sketch.js`      mapa y dibujo con p5.js (oleaje, cuadrícula, flujo de viento, flechas, mancha)
- `js/ui.js`          controles, simulación, reproducción y lecturas
- `vendor/`           Leaflet y p5.js incluidos (los mosaicos del mapa sí requieren internet)
- `herramientas/validar_pronostico.py` valida el TXT antes de publicarlo
- `data/dirmarea.txt` datos de SEMAR
- `data/coast.json`   contorno de costa (Natural Earth 1:10m, dominio público), 56 KB

## Costa fina (lagunas y bahías)
La rejilla de SEMAR (0.16° ≈ 18 km) marca como "tierra" toda celda sin dato, incluidas lagunas y bahías
(p. ej. la Laguna de Términos). Por eso se usa `data/coast.json`:
- Una partícula queda varada solo si toca tierra de verdad (se queda en la orilla, en su última posición en el agua).
- En el agua costera sin dato de SEMAR se usa el viento de la celda con dato más cercana (hasta 4 celdas, ~70 km).
  Es un supuesto: el viento dentro de una laguna puede diferir del de mar abierto. Confirmar con SEMAR.
- Límite: a escala 1:10M, lagunas o canales muy pequeños pueden aparecer como tierra. La capa
  "Línea de costa del modelo" (panel derecho) muestra exactamente qué contorno se está usando.
- Si `coast.json` no carga, la página avisa y vuelve al comportamiento anterior (solo rejilla).

## Notas del modelo
El motor browniano integra la deriva por ola/viento y la difusión aleatoria, con varamiento costero.
Usa las columnas `dirolavto` (dirección de donde viene la ola/viento) y `alturaolavto`
para estimar el viento (`U = sqrt(Hs/0.0246)`); la deriva va en sentido opuesto a `dirolavto`,
con arrastre de 3 % y difusión K = 10 m²/s.
No se modela la corriente marina. Verificado contra el motor de Python: con K = 0 las trayectorias
coinciden hasta ~1e-8°. El coeficiente 0.0246 está por confirmar (ver comentarios en wavefield.js).
