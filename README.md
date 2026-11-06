# Simulador de hidrocarburos — versión p5.js

Mapa (Leaflet: calles / satélite) + datos de SEMAR + simulación de la mancha, dibujados con p5.js.
Sin servidor y sin Python: son solo archivos estáticos (se pueden alojar gratis, p. ej. GitHub Pages).

## Correr en local (Mac)
```bash
cd simulador-p5
python3 servidor.py
```
Abre http://localhost:8000 (no sirve abrir index.html con doble clic: el navegador bloquea la lectura del TXT).
`servidor.py` evita que el navegador guarde copias viejas de los archivos. Si la página se ve sin estilos, recarga con Cmd+Shift+R.

## Uso
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
- `js/coast.js`       costa fina: decide qué es tierra y qué es agua (prueba punto-en-polígono)
- `js/motor.js`       motor Lagrangiano (port de motor.py): deriva por viento + difusión + varamiento
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
Igual que el original: viento estimado del oleaje (U = sqrt(Hs/0.0246)), arrastre 3 %, K = 10 m²/s.
Verificado contra el motor de Python: con K = 0 las trayectorias coinciden hasta ~1e-8°.
El coeficiente 0.0246 está por confirmar (ver comentarios en wavefield.js).
