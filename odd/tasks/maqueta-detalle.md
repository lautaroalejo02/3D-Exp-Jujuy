# Tarea ODD: maqueta-detalle

Locator: `odd/tasks/maqueta-detalle.md` · Engram: `odd/maqueta-detalle/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-detalle` (desde `feat/maqueta-interaccion` @ `1a496e8`)

## Objetivo
Que lugares chicos se vean bien de cerca. La imagen base tiene píxeles de 70 a 140 m, más grandes que las franjas de colores de la Serranía de Hornocal.

## Origen
Lautaro (2026-10-03): "No se ven bien ciertas cosas como el Hornocal o las Salinas."

## Fuentes (verificadas)
| Dato | Fuente | Detalle |
|---|---|---|
| Imagen | EOX Sentinel-2 cloudless **2016**, capa `s2cloudless_3857` (CC BY 4.0) | Verificado en la GetCapabilities de EOX. Las ediciones 2018+ son CC BY-NC-SA y **no** se usan. Plantilla: `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg` (orden `{y}/{x}`, verificado). |
| Relieve | Terrain Tiles, formato Terrarium | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`. En Jujuy está basado en SRTM (~30 m), una inferencia a partir de `tilezen/joerd/docs/data-sources.md`. |

### Resolución elegida
- **Imagen a zoom 14 (~9 m/px):** coincide con los 10 m nativos de Sentinel-2. Un agente de investigación recomendó zoom 18, pero se descartó: serían píxeles de 0,6 m interpolados, más peso sin más detalle.
- **Relieve a zoom 12 (~35 m/px):** coincide con SRTM. Más zoom sería interpolación.

### Sitios
Coordenadas de Wikidata (CC0), verificadas por el coordinador:

| Sitio | Wikidata | Coordenadas |
|---|---|---|
| Serranía de Hornocal | Q16630587 | -23.2617, -65.1226 |
| Salinas Grandes | Q2893104 | -23.63325, -65.8944 |
| Cerro de los Siete Colores | Q1056078 | -23.7469, -65.5035 |

### Datos crudos
`data/raw/detail/`: 270 tiles (3,1 MiB) descargados una sola vez por el coordinador (2026-10-03), en secuencia, sin modificar. El manifiesto `sources.json` tiene la URL y el sha256 de cada tile. Ningún script escribe en `data/raw/`: `verify:detail` vuelve a descargar y compara.

## Alcance autorizado
1. `build:detail`: mosaico por sitio, verificación de sha256 contra el manifiesto, salida en `data/build/detail/`.
2. Capa `src/features/detail/`: un parche por sitio que se dibuja solo cuando la cámara está cerca, sin z-fighting y sin costura visible.
3. Capturas comparativas: Hornocal con parche y sin parche, y Salinas con detalle.
4. Atribuciones.

## Decisión: carga a demanda fuera del loop
Los recursos GPU de cada parche (unos 28 MiB por sitio a resolución completa) **no** se crean al iniciar, porque costarían ~85 MiB aunque el usuario nunca se acerque. Tampoco se crean en el loop de render (regla de `AGENTS.md`). Se crean **una sola vez** en una tarea asíncrona aparte, que se dispara cuando la cámara entra en el umbral de cercanía. Esa tarea tiene su propio try/catch: si falla, solo desactiva ese parche, con un aviso en consola y sin el error de render general. Durante la carga se ve la base. En el perfil móvil la textura del parche se sube a la mitad de resolución (~7 MiB por sitio). Decisión del coordinador por delegación de Lautaro (2026-10-03).

## Límite honesto
Sentinel-2 (10 m) es el techo de la fuente libre. El Hornocal se va a ver mucho mejor que hoy, pero no como en una foto aérea.

## Criterios de aceptación
- En la captura del Hornocal con parche se distinguen las franjas y los pliegues, y la mejora contra la base es evidente.
- Sin costura visible ni z-fighting.
- `build:detail` determinista; `typecheck`, `test`, `check:wgsl`, `build` y `snapshot` en verde.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| D0 | Fuentes + descarga de tiles crudos | coordinador | [x] | 270 tiles, sources.json con sha256 |
| D1 | Build + capa + capturas | delegada (Devin, worktree aparte) | [x] | 260 tests; 3 sitios (sat 2304² z14, DEM 576² z12); descarga ~4,35 MB (lazy); GPU ~28 MiB por sitio; captura hornocal vs base: detalle claramente superior |
| D1b | Correcciones de GGA: carga a demanda fuera del loop (ver Decisión), memoria de los parches en el reporte, la caché de build:detail verifica el sha de los tiles crudos, comentario del margen de elevación, textura a la mitad en móvil | delegada (Devin) | [x] | máquina de estados por sitio testeada; carga async fuera del frameLoop |
| D2+D3 | Parche a la altura real con transición de alturas: la base se descarta en el rectángulo del parche listo y visible; en la banda de fundido el parche interpola entre la altura base y la propia; sin elevación ni domo; el picking usa la altura que se ve | delegada (Devin) | [x] | Primer intento (D2 con domo de costura de hasta 158 m) descartado: quedaba una cresta visible y la integración con regiones se canceló por la licencia de regiones . Resultado: 280 tests; transición de alturas hacia la superficie de la malla base (triángulos, no bilineal) para no dejar grietas; captura hornocal sin escalón ni domo |
