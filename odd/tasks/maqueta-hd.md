# Tarea ODD: maqueta-hd

Locator: `odd/tasks/maqueta-hd.md` · Engram: `odd/maqueta-hd/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-hd` (desde `feat/maqueta-sol` @ `ddccef4`)

## Objetivo
Detalle en alta resolución (~9 m/px de imagen y DEM de ~35 m) para todos los lugares marcados, no solo para los 6 sitios actuales.

## Origen
Lautaro (2026-10-03): "Quiero saber si al menos los puntos que están marcados se pueden hacer HD como los pocos que ya teníamos."

## Datos
`data/raw/detail/sources-3.json` + tiles: 23 sitios nuevos, uno por cada lugar marcado que no tenga ya el centro de un parche a menos de 7 km. Los lugares de la Quebrada que están cerca comparten parche.
- Mismas capas y zooms que el primer lote: EOX Sentinel-2 cloudless 2016 z14 (CC BY 4.0) y Terrarium z12.
- 2070 tiles, 22,2 MiB.
- Descargados una sola vez por el coordinador (2026-10-03), en secuencia y con sha256.
- Los centros usan la coordenada final de cada lugar (Wikidata o OSM).
- Quedan afuera los lugares fuera de Jujuy (Cerro Zapaleri).

Total: 6 sitios previos + 23 nuevos = 29 parches.

## Alcance autorizado
1. **`build:detail`:** procesa `sources.json`, `sources-2.json` y `sources-3.json`, verifica el sha256 de cada tile y mantiene la caché determinista.
2. **Presupuesto de memoria:** como mucho N parches con recursos GPU vivos a la vez, según el perfil (por ejemplo celular 3 y escritorio 8). Cuando hace falta lugar, se descarta el que se usó hace más tiempo o está más lejos (LRU por distancia). Al descartarlo se liberan su textura y su storage. La creación sigue fuera del loop de render.
3. **Rendimiento:** la elección de qué parches cargar se basa en la distancia de cámara y en la visibilidad (frustum). Solo se pide la descarga del JSON y de la imagen de un parche cuando se acerca.
4. **Tamaño:** reportar el peso total de `dist/detail/` y la memoria GPU máxima en celular y en escritorio.
5. **Atribuciones:** se agregan los sitios nuevos a las filas de detalle.

## Criterios de aceptación
- Al acercarse a cualquiera de los lugares marcados de Jujuy se ve el parche HD, sin costuras ni z-fighting.
- La memoria GPU de los parches nunca supera el presupuesto del perfil.
- `typecheck`, `test`, `check:wgsl`, `build` y `snapshot` en verde, con capturas de 3 sitios nuevos (La Quiaca, Laguna de los Pozuelos, Calilegua).

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| H0 | Cálculo de cobertura + descarga | coordinador | [x] | 23 sitios, 2070 tiles, 22,2 MiB |
| H1 | Build + presupuesto LRU + capturas | delegada (Devin) | [x] | 518 tests; 29 sitios; dist/detail 39,5 MiB; GPU máxima: celular 24 MiB (3 activos), escritorio 226 MiB (8 activos); verify:detail con 2610 tiles OK. Deuda: el descarte de recursos usa un handle interno de vgpu (StorageBuffer no expone destroy) |
