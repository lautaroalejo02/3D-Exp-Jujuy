# Tarea ODD: maqueta-lugares

Locator: `odd/tasks/maqueta-lugares.md` · Engram: `odd/maqueta-lugares/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-lugares` (desde `feat/maqueta-detalle` @ `9607f0a`)

## Objetivo
Lugares importantes de Jujuy como marcadores tocables con una ficha. Es el punto 3 del alcance v1 del brief.

## Origen
Lautaro (2026-10-03): "Agregale los puntos importantes de Jujuy, no solo esos dos."

## Datos y licencias
Solo se usan fuentes con licencia compatible con `AGENTS.md`.

| Campo de la ficha | Fuente | Licencia |
|---|---|---|
| Nombre, descripción breve, coordenadas | Wikidata (`label.es`, `description.es`, P625) | CC0 |
| Altura | DEM del proyecto, calculada por script. Nunca a mano. | — |
| Departamento | Raster de límites (geoBoundaries / IGN) | CC BY 3.0 IGO |

### Lo que no entra
- **Región:** su fuente (PIP Jujuy) no tiene licencia abierta y está pendiente de decisión de Lautaro.
- **Textos de Wikipedia:** CC BY-SA, licencia que no está en la lista de `AGENTS.md`. La ficha solo enlaza al artículo.

### Archivo de datos
`data/raw/places/wikidata-places.json`: 35 lugares. Son subconjuntos de entidades de Wikidata descargados una sola vez por el coordinador (2026-10-03), con `lastrevid` como procedencia. `verify:places` vuelve a consultar Wikidata y compara. Ningún script escribe en `data/raw/`.

Excluidos:
- **Dique La Ciénaga y Lagunas de Yala:** sus items de Wikidata no son confiables (asentamientos homónimos).
- **Paleta del Pintor:** solo existe como punto de OSM, sin item de Wikidata.
- **Reserva de Biosfera de las Yungas:** no tiene coordenada.

"Parque provincial Potrero de Yala" no tiene descripción en español: la ficha muestra "Sin descripción".

## Alcance autorizado
1. **Build** (`build:places`): para cada lugar calcula la altura del DEM de resolución completa (y del DEM de detalle si el lugar cae en un parche) y el departamento del raster. Salida: `data/build/places.json`. `verify:places` compara contra Wikidata.
2. **UI:** marcadores en el DOM proyectados desde el mundo 3D (botones accesibles, aptos para touch), con oclusión aproximada contra el relieve en CPU y etiquetas que se ocultan según la distancia o la superposición. Tocar un marcador abre la ficha: nombre, descripción, departamento, altura (DEM), coordenadas, enlace a Wikidata y, si existe, a Wikipedia en español. Botón "Lugares" para mostrar u ocultar la capa, encendido por defecto.
3. **Atribución** de Wikidata (CC0) en `ATTRIBUTIONS.md` y en la página.

## Descripciones retenidas
- **Salinas Grandes (Q2893104):** Wikidata dice "el salar más grande de la Argentina", pero la fuente oficial de turismo (argentina.travel) la ubica tercera en el mundo, después de Uyuni y de Arizaro (Salta). Se retiene: la ficha muestra "Sin descripción", y el motivo queda registrado en `WITHHELD_DESCRIPTIONS` con la URL de la fuente que lo contradice.

## Sin región ni categoría
La lista de investigación traía una categoría por región (Quebrada, Puna…) que depende de la fuente sin licencia. Se eliminó del dato crudo y del código, y la validación rechaza campos que no sean de Wikidata (hallazgo de GGA).

## Criterios de aceptación
- Los 35 lugares aparecen sobre el relieve y responden a mouse y touch.
- Cada ficha muestra la fuente, y la altura sale del DEM.
- `typecheck`, `test`, `check:wgsl`, `build` y `snapshot` en verde.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| L0 | Descarga de Wikidata y selección | coordinador | [x] | 35 lugares con `lastrevid` |
| L1 | Build + verify + marcadores + fichas | delegada (Devin) | [x] | 312 tests; verify:places OK contra Wikidata en vivo; 4 lugares con DEM de detalle; captura places.png |
| L2 | Regresión en iPhone: la capa de lugares capturaba todos los toques (`#overlay > *` ganaba por especificidad) y el mapa no respondía; puntos de ~10 px solo visuales, tap resuelto en el canvas, lista accesible de lugares, sin zoom de página en iOS | delegada (Devin) | [x] | 319 tests |
