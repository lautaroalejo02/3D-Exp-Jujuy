# Tarea ODD: maqueta-ajustes-lugares

Locator: `odd/tasks/maqueta-ajustes-lugares.md` · Engram: `odd/maqueta-ajustes-lugares/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-ajustes` (desde `feat/maqueta-estilo` @ `28358e6`)

## Origen
Lautaro (2026-10-03), probando en el iPhone:
1. "Purmamarca está en medio de una montaña."
2. "Jujuy ciudad no se ve nada."
3. "Las fotos que salen de Jujuy al principio no tienen nada que ver" (aparecían un alfajor y una mesada de granito).

## Diagnóstico (verificado por el coordinador)
1. **Coordenadas imprecisas:** 8 lugares tienen en Wikidata una coordenada redondeada al minuto de arco (precisión 0,0167°, unos 1,8 km). Potrero de Yala la tiene a 0,1° (unos 11 km). Purmamarca cae sobre un cerro.
2. **San Salvador de Jujuy sin detalle:** la imagen base tiene píxeles de 70 a 140 m. Una ciudad necesita un parche como los del Hornocal. El techo de la fuente libre (Sentinel-2) es de 10 m: se ven la mancha urbana, las avenidas y el río, no las manzanas.
3. **Fotos no relacionadas:** salían de "hasta 12 archivos de la categoría de Commons", que incluye cualquier cosa sacada en la ciudad.

## Datos nuevos
Descargados una sola vez por el coordinador el 2026-10-03.

| Archivo | Contenido | Licencia |
|---|---|---|
| `data/raw/places/osm-coordinates.json` | 8 coordenadas de OpenStreetMap (Nominatim) para los lugares con precisión gruesa. Cada una es el elemento OSM cuyo tag `wikidata` coincide con el Q-id. Purmamarca pasa de (-23,7333; -65,4833) a (-23,7466; -65,4992). | ODbL 1.0, "© OpenStreetMap contributors" |
| `data/raw/places/commons-photos-depicts.json` | Fotos elegidas **solo por relevancia**: la foto principal de Wikidata (P18) más los archivos cuyos datos estructurados en Commons dicen que representan el lugar (P180 = Q-id). 72 fotos en 28 lugares. **Reemplaza** a `commons-photos.json`, que deja de usarse; el archivo viejo queda como registro histórico. | — |
| `data/raw/detail/sources-2.json` + tiles | Parches de detalle de **San Salvador de Jujuy** (Q44217), **Humahuaca** (Q1026833) y **Tilcara** (Q604722): las mismas capas y zooms que el primer lote. 270 tiles, 3,2 MiB. | — |

## Exclusiones editoriales de fotos
Se excluyen siempre con el motivo registrado en el código:

| Lugar | Archivo | Motivo |
|---|---|---|
| San Salvador de Jujuy | "Alfajor de Frutos Rojos marca La Viandita Dulce de San Salvador de Jujuy.jpg" | Objeto comercial, no el lugar |
| San Salvador de Jujuy | "Jujuy, energía viva.jpg" | Pieza gráfica o promocional |
| Maimará | "Afiche 8 Sintesis Cultural Andina Masi Maky 2018.jpg" | Afiche |
| Maimará | "Viento zonda en Maimara con alerta amarilla consecuencias de tormenta de polvo y arena en la zona.jpg" | Evento meteorológico puntual; no muestra el lugar |
| Quebrada de Humahuaca | "Tormenta de tierra y arena en Maimara Jujuy Argentina Junio 2026.jpg" | Otro lugar (Maimará) y evento puntual |
| Quebrada de Humahuaca | "Doña Feliza Choique de Cunchilla, 80 años de Carnaval.jpg" | Retrato de una persona |
| Salinas Grandes | "Protest sign against lithium mining in Salinas Grandes 12.jpg" | Neutralidad: el tema del litio se trata aparte, con fuentes |
| Santa Catalina | las 5 fotos (Timón Cruz, Yoscaba, Cusi-Cusi) | Muestran otras localidades del departamento, no Santa Catalina |
| Rinconada | "Valle de la Luna Jujeño, Cercanías de Cusi-Cusi…" | Otra localidad |
| Termas de Reyes | "Dr Manuel Belgrano, Jujuy, Argentina - panoramio.jpg" | No se puede confirmar que muestre las termas |

## Alcance autorizado
1. **Build de lugares:**
   - usa `osm-coordinates.json` cuando la precisión de Wikidata es de 0,001° o más;
   - la ficha cita OSM (ODbL) para esas coordenadas;
   - pasa a leer `commons-photos-depicts.json` y aplica las exclusiones editoriales;
   - recalcula la altura y el departamento con la coordenada nueva.
2. **Build de detalle:** procesa también `sources-2.json`, verifica el sha256 y genera los 3 parches nuevos.
3. **Parches superpuestos:** Tilcara con Siete Colores, Humahuaca con Hornocal. El render tiene que manejarlos sin z-fighting ni huecos: prioridad por sitio, recorte del rectángulo de la base contra todos los parches listos, y nada de doble dibujo en la zona común.
4. **Atribuciones:** OSM (ODbL) en `ATTRIBUTIONS.md`, en la página y en la ficha.

## Criterios de aceptación
- Purmamarca, Abra Pampa, Libertador, San Pedro, Yala, Potrero de Yala, Guayatayoc y Pozuelos caen sobre el lugar (verificado en capturas cercanas o por la altura del DEM).
- San Salvador de Jujuy, Humahuaca y Tilcara se ven con detalle al acercarse.
- Las fotos de San Salvador ya no muestran el alfajor ni el granito.
- `typecheck`, `test`, `check:wgsl`, `build` y `snapshot` en verde.
- Prueba táctil de Lautaro.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| A0 | Diagnóstico + datos nuevos | coordinador | [x] | 8 overrides de OSM, 72 fotos por P180, 270 tiles |
| A1 | Build + render de parches superpuestos + atribuciones | delegada (Devin) | [x] | 420 tests; 8 coordenadas de OSM; 58 fotos en 25 lugares (14 exclusiones, verificadas en el código: el reporte de Devin inventó nombres de archivo); 6 parches, con reparto por el centro más cercano y geomorfismo en la frontera; capturas purmamarca.png (punto en el pueblo) y san-salvador.png (mancha urbana) |
