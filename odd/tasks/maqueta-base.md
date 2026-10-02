# Tarea ODD: maqueta-base

Locator: `odd/tasks/maqueta-base.md` · Engram: `odd/maqueta-base/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-base`

## Objetivo
Base de la app (Vite + TS strict + vgpu 0.5) sobre la que después se suman regiones, lugares, perfil de altura y lluvia. Esas cuatro NO se implementan ahora, pero la arquitectura las deja fáciles de agregar.

## Alcance autorizado (pedido de Lautaro, 2026-10-02)
1. Proyecto Vite + TypeScript strict + vgpu 0.5. Leer `npx vgpu docs cat getting-started.md` y `two-pass-rendering.md` antes de escribir render.
2. Pipeline de datos en `scripts/` (`data/raw/` → `data/build/`), re-ejecutable y determinista.
   - DEM Terrarium `jujuy_terrarium_z10_x320-329_y575-584.png`: altura = R*256 + G + B/256 - 32768 m.
   - Satélite `jujuy_s2cloudless2016_z11_x641-659_y1150-1169.jpg`.
   - Ambos Web Mercator. Recorte del DEM desde x=128 px, ancho 2432, alto 2560: coincide exacto con el satélite (escala 2x).
   - Alturas en metros reales (las van a consultar perfil y fichas).
   - Cliente por defecto: satélite 2432x2560 y alturas a media resolución. Calidad alta: resolución completa.
3. Módulo geo: lat/lon ↔ Web Mercator ↔ grilla ↔ mundo 3D, con tests unitarios.
4. Render del terreno: textura satelital, iluminación que haga leer el relieve, exageración vertical configurable (inicial 2.5x).
5. Controles mouse y touch: rotar, paneo, zoom, pinch.
6. Tocar/clickear el terreno muestra lat/lon y altura del DEM (base del picking).
7. Sin WebGPU: aviso claro, nunca pantalla en blanco.
8. Atribuciones de datos visibles en la UI (según `ATTRIBUTIONS.md`).
9. `DECISIONS.md`: decisiones técnicas, qué le faltó a vgpu y qué se hizo a mano, performance (tamaño de descarga y memoria GPU por modo), propuesta de próximas iteraciones.

Fuera de alcance: regiones, lugares, perfil, lluvia (solo se dejan los puntos de enganche).

## Estructura acordada
```
scripts/build-data.ts      raw → data/build (alturas Int16 m, satélite, terrain.json; default + alta)
src/main.ts                detección WebGPU → app o aviso
src/geo/                   puro + tests
src/terrain/heightfield.ts puro: muestreo bilineal en metros
src/terrain/terrain-layer.ts + terrain.wgsl
src/render/                frame dos pasadas (target depth + effect de composición)
src/camera/                camera.ts (puro) + input.ts (Pointer Events)
src/picking/ray.ts         puro: rayo vs heightfield en CPU
src/app/layers.ts          interfaz Layer { init, update, draw, onPick?, ui? }
src/ui/                    aviso sin WebGPU, panel lat/lon/altura, atribuciones
src/features/<nombre>/     (futuro) regiones, lugares, perfil, lluvia
```

## Restricciones
- `AGENTS.md`: TS strict, sin `any` injustificado, solo vgpu para render, shaders `.wgsl` validados con `npx vgpu check`, recursos GPU creados una sola vez, mouse + touch, dependencias justificadas, `data/raw/` intocable, `data/build/` ignorado.
- Alturas nunca escritas a mano.
- Commits: Conventional Commits, sin línea de co-autoría. Commit + push por tarea.

## Entrega
- Estrategia: `single-pr` sobre `feat/maqueta-base` (pedido explícito de Lautaro: una rama, commit y push a medida que avanza). Pronóstico: > 400 líneas; se documenta acá, sin partir en PRs encadenados.
- Deploy: preview en Vercel con el CLI (`vercel`), no producción.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| T1 | AGENTS.md (fuente de verdad openspec/ u odd/tasks/) + ATTRIBUTIONS.md Terrain Tiles | inline (1 archivo mecánico c/u) | [ ] | |
| T2 | Scaffold Vite + TS strict + vitest + vgpu; aviso sin WebGPU; panel de atribuciones | delegada (Devin swe-2-high): 2+ archivos | [ ] | |
| T3 | Módulo geo + tests (TDD) | delegada (Devin) | [ ] | |
| T4 | Pipeline de datos + tests de funciones puras | delegada (Devin) | [ ] | |
| T5 | Render del terreno (vgpu), calidad default/alta, captura headless | delegada (Devin; fallback subagente Claude) | [ ] | |
| T6 | Cámara + controles mouse/touch | delegada (Devin) | [ ] | |
| T7 | Picking + panel lat/lon/altura | delegada (Devin) | [ ] | |
| T8 | Mediciones, DECISIONS.md, deploy preview, Engram | inline + verificación | [ ] | |
| T9 | Auditoría independiente: alineación DEM↔satélite + matemática geo | delegada (Codex) | [ ] | |

## Criterios de aceptación
- `npm run dev` muestra la maqueta y se reconocen la Quebrada de Humahuaca y la Puna (confirmación visual de Lautaro).
- Rotar, paneo y zoom con mouse y touch.
- Tocar un punto muestra una altura coherente con el DEM.
- Tests de geo pasan y `npm run build` funciona.

## Progreso
- 2026-10-02: rama creada desde `036c136`. RDD `on` (default). Devin `swe-2-high` disponible.

## Próximo paso
T1 commit, luego T2.
