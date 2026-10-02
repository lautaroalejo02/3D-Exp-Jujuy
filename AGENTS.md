# AGENTS.md: Maqueta 3D de Jujuy

Web educativa para secundaria: maqueta 3D del relieve real de Jujuy con imagen satelital, regiones (Puna, Quebrada, Valles, Yungas), lugares con ficha, perfil de altura y lluvia simplificada. Sitio estático, sin backend.

## Cómo se trabaja
- La fuente de verdad son los specs SDD en `openspec/`. No implementar nada que no esté en una tarea del spec.
- Si el spec es ambiguo, contradice al código o parece estar mal: frenar y avisar. No adivinar.
- Una tarea por rama y por PR. Commits chicos con Conventional Commits.
- No usar `--no-verify` salvo que Lautaro lo pida.

## Stack
- TypeScript con `strict: true`. Nada de `any` sin justificar en un comentario.
- Render solo con vgpu 0.5.x (WebGPU). No sumar three.js, WebGL ni otras librerías de render.
- Antes de tocar render, leer `npx vgpu docs cat getting-started.md` y `two-pass-rendering.md`.
- Shaders en archivos `.wgsl`, validados con `npx vgpu check <archivo>`.
- Crear recursos GPU (targets, draws, effects, buffers) una sola vez; en el loop solo se actualizan datos.
- Sin WebGPU: mostrar un aviso claro. Nunca pantalla en blanco ni error sin manejar.
- Toda interacción funciona con mouse y con touch.
- No agregar dependencias sin justificarlo en el PR.

## Datos y contenido educativo (lo más importante)
- Todo dato educativo (textos de fichas, regiones, clima, vegetación, fechas, áreas protegidas) lleva fuente con URL junto al dato. Sin fuente no se mergea.
- Alturas, distancias y desniveles se calculan del DEM con scripts. Nunca se escriben a mano ni de memoria.
- Las coordenadas de lugares llevan fuente y se verifican contra el DEM y la imagen satelital.
- Si no hay fuente confiable, dejar un TODO explícito y avisar. No inventar ni completar con datos plausibles.
- Textos en español de Argentina, claros para secundaria, sin jerga innecesaria.
- `data/raw/` no se modifica. Todo lo derivado se genera con scripts en `scripts/` hacia `data/build/` (ignorado por git). Los scripts deben poder correrse de nuevo y dar el mismo resultado.
- Solo datos con licencia compatible (CC BY, ODbL, dominio público). Cada fuente va en `ATTRIBUTIONS.md` y las atribuciones se ven en la página.

## Tests y verificación
- Lógica de cálculo (perfil de altura, escurrimiento, conversión de coordenadas) en funciones puras con tests unitarios.
- Cambios visuales: adjuntar captura o render headless en el PR.
- Cada PR dice qué tarea del spec cierra y cómo se verificó.

## Qué rechazar en una revisión
- Datos educativos sin fuente o alturas escritas a mano.
- Recursos GPU creados dentro del loop de render.
- Dependencias nuevas sin justificación.
- `any` sin justificar, errores tragados en silencio.
- Archivos de `data/build/`, `node_modules/` o secretos commiteados.
