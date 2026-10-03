# Tarea ODD: maqueta-lugares-fichas

Locator: `odd/tasks/maqueta-lugares-fichas.md` · Engram: `odd/maqueta-lugares-fichas/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-lugares-fichas` (desde `feat/maqueta-regiones-v2` @ `3c2d3f5`)

## Objetivo
Fichas de lugares más completas: fotos arriba de la descripción (se agrandan al tocarlas) y un botón "Ver más" con más información.

## Origen
Lautaro (2026-10-03): "Que al apretar un lugar salga un poco más de información o un botón 'ver más'… ver unas fotos del lugar arriba de la descripción. En desktop, que tengan un buen tamaño; en mobile, que se puedan ver, mientras no tapen todo el mapa; y apretar para verlas más grandes."

## Licencias (decisión de Lautaro, 2026-10-03)
Lautaro aprobó ampliar las licencias permitidas a **CC BY-SA** para:
- fotos de Wikimedia Commons;
- extractos de Wikipedia.

Condición: autor, licencia y enlace visibles junto a cada foto o texto. Se refleja en `AGENTS.md`.

Antes de la decisión, solo 6 de las 27 fotos principales eran compatibles; 21 eran CC BY-SA.

## Datos
Descargados una sola vez por el coordinador (2026-10-03), en secuencia y con User-Agent identificado. Están en `data/raw/places/`:

| Archivo | Contenido |
|---|---|
| `commons-photos.json` | 109 fotos en 26 lugares: la principal de Wikidata (P18) más hasta 12 candidatas de la categoría de Commons (P373), con un máximo de 5 por lugar. Filtradas a CC BY / CC BY-SA / CC0 / dominio público y ancho de al menos 600 px. Incluye autor, licencia, URL de la licencia, página del archivo y miniatura. Las imágenes se cargan en tiempo de ejecución desde las miniaturas de Wikimedia (no se suben al repo). |
| `wikipedia-extracts.json` | 35 resúmenes de Wikipedia en español (REST v1), con la revisión. CC BY-SA 4.0. Se muestran textuales con atribución. |
| `wikidata-facts.json` | Datos estructurados (CC0): tipo, población más reciente con año, superficie, patrimonio y fundación. |

Ningún script escribe en `data/raw/`. `verify:places` revisa cambios de licencia y de revisión.

## Alcance autorizado
Tarea F1, según el prompt de implementación:
- build y verify;
- fichas con tira de fotos y lightbox;
- "Ver más" con el extracto y los datos;
- atribuciones;
- actualización de `AGENTS.md`.

## Criterios de aceptación
- Las fotos se ven arriba de la descripción y se agrandan al tocarlas.
- En celular la ficha ocupa como máximo ~55% de la pantalla y el mapa sigue usable.
- Cada foto muestra autor y licencia; el extracto, su fuente y licencia.
- `typecheck`, `test`, `build` y `snapshot` en verde.
- Prueba táctil de Lautaro en el celular.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| F0 | Relevamiento de licencias + descarga de datos | coordinador | [x] | 109 fotos / 26 lugares, 35 extractos, 35 fichas de datos |
| F1 | Build + fichas + lightbox + "Ver más" | delegada (Devin) | [x] | 375 tests; places.json: 26 lugares con 109 fotos, 35 extractos, 35 fichas de datos; verify:places OK (35 entidades, 109 licencias, 35 revisiones) |
| F2 | Correcciones de GGA: fotos CC BY/BY-SA sin autor descartadas en el build; enlace a la licencia del extracto; fuente de los datos de Wikidata; el lightbox no se cierra al deslizar; foco del lightbox | delegada (Devin) | [x] | ver commit |
| F3 | Correcciones de GGA: zoom del lightbox con mouse (rueda y doble clic), credit cuando falta el autor, validación de licencias permitidas en el build | delegada (Devin) | [x] | ver commit |
