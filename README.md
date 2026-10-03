# 3D-Exp-Jujuy

Maqueta 3D del relieve de Jujuy (educativa, secundaria). Sitio estático con
Vite + TypeScript strict + vgpu 0.5 (WebGPU). Ver `AGENTS.md` y
`odd/tasks/maqueta-base.md`.

## Comandos

- `npm install` — instalar dependencias
- `npm run verify:boundaries` — descarga el archivo oficial geoBoundaries ARG ADM2 (commit fijado, ~70 MB, según el `provenance` del extracto) y verifica que `data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson` coincida con una re-selección en memoria (sha256 + features, geometría y propiedades). No escribe nada; sale con error si hay diferencias
- `npm run build:data` — genera `data/build/` (alturas Int16, satélite, departamentos, `terrain.json`) desde `data/raw/`; idempotente, `--force` reconstruye. Requiere el extracto commiteado `data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson`
- `npm run build:detail` — genera `data/build/detail/` (parches de alta resolución por sitio: satélite z14 mosaico + alturas z12 Int16 + `manifest.json`); idempotente, `--force` reconstruye. Verifica el sha256 de cada tile crudo contra `data/raw/detail/sources.json` antes de usarlo
- `npm run verify:detail` — vuelve a descargar cada URL de `data/raw/detail/sources.json` y compara el sha256 (también contra la copia local). No escribe nada; sale con error si hay diferencias
- `npm run build:places` — genera `data/build/places.json` (los 35 lugares de `data/raw/places/wikidata-places.json` con altura bilineal del DEM — y del DEM de detalle cuando el punto cae en un parche — y departamento del raster geoBoundaries); idempotente, imprime «up to date» si nada cambió
- `npm run verify:places` — vuelve a consultar cada Q-id en Wikidata (secuencial, con pausa) y compara etiqueta, descripción y coordenadas contra el archivo crudo; además re-verifica la licencia de cada foto en Commons y que cada revisión de extracto siga existiendo en es.wikipedia. No escribe nada; sale con error si hay diferencias
- `npm run dev` — servidor de desarrollo (sirve `data/build/` en la raíz del sitio)
- `npm run build` — `build:data` + `build:detail` + `build:places` + typecheck + build a `dist/` (sin las imágenes `debug-*.png`)
- `npm run typecheck` — `tsc --noEmit` (app + `scripts/` vía `tsconfig.scripts.json`)
- `npm test` — Vitest
- `npm run check:wgsl` — valida cada `src/**/*.wgsl` con `vgpu check`

## Controles de la cámara

| Gesto | Acción |
|---|---|
| Arrastrar (botón izquierdo o un dedo) | Rotar el relieve |
| Arrastrar con botón derecho/medio, o Shift/Ctrl + izquierdo | Desplazar el terreno |
| Dos dedos juntos | Desplazar el terreno |
| Pinza (dos dedos) | Acercar / alejar |
| Girar dos dedos | Rotar en azimut |
| Rueda del mouse | Acercar / alejar |
| Toque o click corto | Seleccionar un punto (picking) |

## Parámetros de URL y debug

- `?calidad=alta` — satélite y alturas a resolución completa (default: media).
- `?perfil=movil|escritorio` — fuerza el perfil de dispositivo (default:
  autodetectado por puntero, pantalla, `deviceMemory` y límites del adapter).
- `?debug=1` — overlay con FPS/ms promedio, perfil, calidad, malla, DPR,
  tamaño del canvas y memoria GPU.

El render es **a demanda**: solo se dibuja cuando algo cambia (cámara,
exageración, picking, resize) y el loop se pausa con la pestaña oculta. En
perfil móvil la malla baja a 304x320 vértices y el DPR se topea en 1.5
(escritorio: 608x640, DPR ≤ 2; `?calidad=alta` en móvil usa 608x640 con un
aviso de que puede ir lenta).

## Datos generados (`data/build/`)

`npm run build:data` produce, desde `data/raw/`:

- `heights-full.bin` — DEM 2432x2560 Int16-LE, metros. Elevación: min 26 m,
  max 6131 m, media 2966.6 m; percentiles p0.1% = 285 m y p99.9% = 5524 m.
  (El mínimo de 26 m es un pozo de ~7 píxeles en el dato fuente, rodeado de
  terreno ~300 m — no es un error de decodificación.)
- `heights-half.bin` — 1216x1280, box-filter 2x2 del full-res. Elevación:
  min 100.5 m, max 6122.75 m, media 2966.6 m; p0.1% = 284.75 m,
  p99.9% = 5523.25 m. Error de reconstrucción vs full-res (bilineal en cada
  celda full-res): max 501.3 m, media 7.45 m, p99 40.9 m; 10.03% de las
  celdas superan 20 m — esperable en terreno montañoso abrupto.
- `satellite-full.jpg` (4864x5120, copia del original) y
  `satellite-half.jpg` (2432x2560, jpeg q85).
- `departments-full.bin` (2432x2560) y `departments-half.bin` (1216x1280) —
  índice departamental Uint8 por celda: 0 = fuera de la provincia,
  1..16 = departamento (orden alfabético por el `shapeName` normalizado
  de la fuente; la mitad de resolución usa mayoría del bloque 2x2). Se
  rasterizan desde `data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson`.
- `province-sdf-full.bin` y `province-sdf-half.bin` — distancia con signo
  al borde provincial en celdas (Int8, positiva adentro, negativa afuera,
  clamp ±127; EDT exacta de Felzenszwalb). Sirve para dibujar el contorno
  nítido a cualquier zoom.
- `departments.json` — índice → nombre tal como figura en la fuente
  (`shapeName`, p. ej. «Yaví»), atribución y licencia (geoBoundaries
  gbOpen ARG ADM2, CC BY 3.0 IGO).
- `terrain.json` — manifiesto con grillas, hashes sha256, estadísticas de
  elevación, el error de reconstrucción y el bbox de la provincia
  (lon/lat y celdas por nivel).
- `places.json` (lo genera `npm run build:places`) — los 35 lugares con
  nombre y descripción en español de Wikidata (CC0), coordenadas, altura
  del DEM a resolución completa (y del DEM de detalle cuando el punto cae
  en un parche, con `elevationSource` que dice cuál usa la ficha),
  departamento del raster geoBoundaries («Fuera de Jujuy» si cae afuera)
  y enlaces a Wikidata/es.wikipedia. Además fusiona, por lugar, las fotos
  de Wikimedia Commons (`commons-photos.json`; autor, licencia y enlaces
  por foto, con `fullUrl` derivado del patrón de miniaturas y sin params
  `utm_*`), el extracto de Wikipedia en español
  (`wikipedia-extracts.json`, CC BY-SA 4.0, con revisión) y los datos
  estructurados de Wikidata (`wikidata-facts.json`, CC0; años derivados
  de los literales de tiempo). La capa `src/features/places/` los
  dibuja como marcadores DOM proyectados por cuadro, con oclusión
  aproximada contra el relieve y desempalme de etiquetas; el interruptor
  «Lugares» los enciende/apaga. La ficha muestra la tira de fotos arriba
  de la descripción (lightbox al tocarlas) y un «Ver más» con el
  extracto y los datos.
- `debug-alignment.png` — hillshade sobre satélite para verificar la
  registración DEM/imagen (no se publica en `dist/`).
- `debug-province.png` — contorno de la provincia y bordes departamentales
  sobre el satélite, para verificación visual (no se publica en `dist/`).

`npm run build:detail` produce `data/build/detail/`:

- `detail/<sitio>/satellite.jpg` — mosaico Sentinel-2 cloudless 2016 (EOX,
  `s2cloudless_3857`, z14 ~9 m/px) de 2304x2304 por sitio, jpeg q85.
- `detail/<sitio>/heights.bin` — DEM Terrarium z12 (~35 m/px) recortado a
  la extensión exacta del mosaico satelital, 576x576 Int16-LE en metros.
- `detail/manifest.json` — por sitio: id, nombre, fuente Wikidata, grillas,
  tamaños y sha256 de los archivos, estadísticas de elevación, tamaño en km
  y `liftMeters` (elevación uniforme que la capa aplica para que el parche
  gane el test de profundidad sobre el terreno base).

La capa `src/features/detail/` dibuja cada parche solo cuando la cámara
está a menos de ~4× el tamaño del parche. Los recursos GPU de cada sitio
(~28 MiB; ~7 MiB en perfil móvil, que sube el satélite a media resolución)
se crean una sola vez, en una tarea aparte fuera del loop de render,
disparada cuando la cámara entra en el umbral (`update()` solo detecta y
encola; la máquina de estados por sitio está en `detail-load.ts`). Mientras
carga se ve el terreno base; si falla, el sitio se desactiva con un aviso
en consola. La memoria GPU reportada (consola y `?debug=1`) solo cuenta los
sitios ya creados — el total crece a medida que se acerca la cámara.
