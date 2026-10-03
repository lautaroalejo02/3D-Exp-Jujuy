# 3D-Exp-Jujuy

Maqueta 3D del relieve de Jujuy (educativa, secundaria). Sitio estático con
Vite + TypeScript strict + vgpu 0.5 (WebGPU). Ver `AGENTS.md` y
`odd/tasks/maqueta-base.md`.

## Comandos

- `npm install` — instalar dependencias
- `npm run verify:boundaries` — descarga el archivo oficial geoBoundaries ARG ADM2 (commit fijado, ~70 MB, según el `provenance` del extracto) y verifica que `data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson` coincida con una re-selección en memoria (sha256 + features, geometría y propiedades). No escribe nada; sale con error si hay diferencias
- `npm run build:data` — genera `data/build/` (alturas Int16, satélite, departamentos, `terrain.json`) desde `data/raw/`; idempotente, `--force` reconstruye. Requiere el extracto commiteado `data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson`
- `npm run dev` — servidor de desarrollo (sirve `data/build/` en la raíz del sitio)
- `npm run build` — `build:data` + typecheck + build a `dist/` (sin las imágenes `debug-*.png`)
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
- `debug-alignment.png` — hillshade sobre satélite para verificar la
  registración DEM/imagen (no se publica en `dist/`).
- `debug-province.png` — contorno de la provincia y bordes departamentales
  sobre el satélite, para verificación visual (no se publica en `dist/`).
