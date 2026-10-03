# Tarea ODD: maqueta-movil

Locator: `odd/tasks/maqueta-movil.md` · Engram: `odd/maqueta-movil/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-movil` (desde `feat/maqueta-base` @ `e42bbb5`)

## Objetivo
Que la maqueta funcione mejor en celulares con WebGPU. Es un objetivo explícito de la v1 en el brief: "PC y celular por igual donde haya WebGPU".

## Origen
Pedido de Lautaro (2026-10-03), después de probar la v1 en su iPhone: "si podemos hacer que funcione en celular mejor". Funciona, pero en vertical la maqueta queda chica y la etiqueta de calidad es ambigua.

## Alcance autorizado
1. **Perfil de dispositivo automático** (`movil`/`escritorio`), con override por URL `?perfil=movil|escritorio`.
   - Móvil: malla de 304x320 vértices en calidad normal y DPR máximo de 1,5.
   - Calidad alta en móvil: malla de 608x640 con aviso.
2. **Render a demanda:** solo se dibuja cuando algo cambia, y el loop se pausa cuando la pestaña no está visible.
3. **Overlay de diagnóstico `?debug=1`:** FPS, ms por frame, perfil, calidad, malla, DPR y memoria GPU. Sirve para medir FPS en dispositivos reales, que el entorno headless no puede.
4. **UI táctil:** áreas de toque de 44 px como mínimo, `safe-area-inset` y panel de altura como hoja inferior. Sin scroll ni zoom por doble toque sobre la app, pero sin bloquear el zoom del texto.
5. **Recuperación:** botón "Recargar" en el aviso de pérdida de GPU o de error de render.

Fuera de alcance: renderer alternativo (decisión cerrada del brief) y la forma de la provincia (va en `maqueta-provincia`).

## Criterios de aceptación
- En un celular con WebGPU se ve y responde (confirmación de Lautaro con `?debug=1`).
- Sin cambios visuales en desktop: las capturas headless dan el mismo resultado.
- Tests de las funciones puras nuevas (perfil, dirty tracking). `typecheck`, `test`, `check:wgsl`, `build` y `snapshot` en verde.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| M1 | Perfil + render a demanda + debug + UI táctil + Recargar | delegada (Devin swe-2-high) | [ ] | 180 tests; capturas idénticas (MD5); GGA FAILED 1º intento: faltaba documento de tarea + rama propia; la rama de límites del adapter era código muerto |
| M2 | Quitar el chequeo de límites del adapter: por la especificación, nunca están debajo de los defaults | delegada (Devin) | [ ] | |

## Notas
- Memoria GPU en móvil (normal, 390x844 a DPR 1,5): ~43,5 MiB. La ganancia real está en los vértices por draw: ~0,58 M contra 2,33 M.
- RDD: bajo/medio se saltea y se registra acá (política de Lautaro); alto se consulta.

## Próximo paso
M2, commit, deploy a producción y medición de Lautaro en el celular.
