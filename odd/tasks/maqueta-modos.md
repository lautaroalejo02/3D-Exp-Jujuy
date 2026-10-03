# Tarea ODD: maqueta-modos

Locator: `odd/tasks/maqueta-modos.md` · Engram: `odd/maqueta-modos/tasks` (proyecto `3d-exp-jujuy`) · Ramas por etapa: `feat/maqueta-menu` (etapa 1), `feat/maqueta-sol` (etapa 2), y las siguientes encadenadas.

## Objetivo
La mayoría de los usuarios entra desde el celular. Por eso todo se diseña y se prueba primero en mobile (unos 390 px de ancho, uso con el pulgar) y después se adapta a desktop, que es secundario y sirve sobre todo para presentaciones.

## Origen
Pedido de Lautaro (2026-10-03), textual en lo esencial:
1. **Rediseño del menú:**
   - barra de modos abajo (Explorar, Sol, Perfil, Agua);
   - cada modo abre un bottom sheet que se puede arrastrar y minimizar;
   - Lugares como búsqueda o lista dentro de un sheet;
   - el mapa es el protagonista;
   - en desktop, el mismo sistema funciona como panel lateral.
2. **Modo Sol:**
   - hora del día con la posición solar real para Jujuy (algoritmo estándar);
   - botón de play;
   - presets de fecha (solsticio de verano, solsticio de invierno, hoy) o selector;
   - **sombras proyectadas** del relieve (no solo hillshade), con el objetivo puesto en las sombras largas al atardecer en la Quebrada;
   - medir el costo en mobile;
   - luz cálida al amanecer y al atardecer.
3. **Modo Perfil:**
   - dos puntos que se pueden arrastrar;
   - el gráfico del corte en el sheet;
   - recorrer el gráfico marca la posición en el mapa, y al revés;
   - máxima, mínima, desnivel y distancia;
   - reusar `sampleAlong` y el picking.
4. **Modo Agua:**
   - dirección y acumulación de flujo precalculadas offline;
   - partículas en GPU (compute), con la cantidad según el dispositivo;
   - cuencas principales (opcional).
5. **Bordes:** corregir el escalón entre skirt y base. Después, formato híbrido: Jujuy recortado en relieve con una sola pared limpia, y el entorno desaturado, más oscuro y achatado.

### Restricciones
- Fluido en un iPhone de gama media. Si algo no llega, se degrada (menos partículas, sombras de menor resolución) en vez de sacarse.
- Orden: primero el menú y el Sol. **Se muestra cada etapa a Lautaro antes de seguir.**

## Etapas
| Etapa | Contenido | Estado |
|---|---|---|
| 1 | Menú: barra de modos + bottom sheets + Explorar (lugares con búsqueda, regiones, exageración, calidad) + panel lateral en desktop + harness de capturas de la interfaz a 390 px | en curso |
| 2 | Motor del Sol (posición solar, sombras proyectadas, color de la luz) + sheet del Sol | motor en curso en paralelo; el sheet espera la etapa 1 |
| 3 | Perfil | pendiente (después de mostrar 1 y 2) |
| 4 | Agua | pendiente |
| 5 | Bordes (bug del escalón + formato híbrido) | pendiente |

## Decisiones técnicas
### Sombras: textura de sombras por compute, recalculada solo cuando cambia el sol
- **Descartado: ray marching por píxel.** Habría que recalcular en cada píxel y en cada frame; en celular es caro.
- **Descartado: shadow map clásico.** Sobre 340 km de relieve, a una resolución razonable, da aliasing y bordes dentados.
- **Elegido:**
  - un compute shader marcha desde cada celda de una textura de sombras (alineada con la grilla) hacia el sol sobre el heightfield que ya está en la GPU, y guarda un valor de visibilidad suave (penumbra aproximada por el ángulo mínimo);
  - el shader del terreno la muestrea con filtrado;
  - se recalcula **solo cuando cambia la posición del sol** (render a demanda); con el play, como mucho una vez por frame;
  - calidad según el dispositivo: escritorio con 1216×1280 y unos 128 pasos, celular con 608×640 y unos 64 pasos;
  - el overlay `?debug=1` muestra los milisegundos del recálculo.
- **Parches de detalle:** usan la misma textura (resolución base). Sombras finas dentro del parche quedan como mejora posterior, si hace falta.

### Posición solar
- Algoritmo de NOAA (ecuaciones de Spencer/NOAA: declinación, ecuación del tiempo, ángulo horario, elevación y azimut), con corrección por refracción.
- Zona horaria de Argentina: UTC−3, sin horario de verano.
- Tests contra valores del NOAA Solar Calculator para San Salvador de Jujuy (fecha y hora fijas), con tolerancia de unas décimas de grado.

### Herramienta de prueba de la interfaz
- Lautaro aprobó usar Playwright "como haga falta" (2026-10-03).
- **Playwright** como dependencia de desarrollo, para capturar la interfaz real (DOM sobre WebGPU con SwiftShader, o el aviso de respaldo si no hay WebGPU headless) en viewports de 390×844 (celular) y 1440×900 (escritorio).
- **Justificación:** los errores de interfaz que hubo (gestos bloqueados, paneles superpuestos) no los detectaban los tests ni las capturas 3D. No se publica en el bundle.

## Criterios de aceptación de la etapa 1
- En 390×844 no queda ningún panel fijo arriba: barra de modos abajo y un sheet arrastrable con tres alturas (minimizado, medio, completo).
- El mapa queda libre en el sheet minimizado.
- Lugares como búsqueda o lista en el sheet de Explorar.
- En desktop, panel lateral con los mismos modos.
- Capturas de Playwright en 390 y en 1440.
- `typecheck`, `test`, `build` y `snapshot` en verde.
- Prueba táctil de Lautaro.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| S1 | Menú + sheets + Explorar + panel lateral + harness | delegada (Devin, worktree isonade-menu) | [x] | 476 tests; harness de Playwright con WebGPU real (Chrome con SwiftShader); correcciones S1b (encuadre según el espacio libre que deja la interfaz, agrupación de marcadores, sheet minimizado limpio, sin nombre duplicado, fly-to con contexto) y S1c (al abrir una ficha, Explorar se minimiza y la ficha queda a media pantalla); capturas en data/build/ui-shots |
| S2a | Motor del Sol (solar + sombras + luz) | delegada (Devin, worktree isonade-sol) | [ ] | |
| S2b | Sheet del Sol sobre el menú | delegada | [ ] | |
