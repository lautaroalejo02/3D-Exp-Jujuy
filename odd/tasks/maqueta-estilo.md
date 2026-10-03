# Tarea ODD: maqueta-estilo

Locator: `odd/tasks/maqueta-estilo.md` · Engram: `odd/maqueta-estilo/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-estilo` (desde `feat/maqueta-regiones-v2` @ `3c2d3f5`)

## Objetivo
Mejor estilo visual de los controles, y un entorno en lugar del fondo negro plano.

## Origen
Lautaro (2026-10-03):
- "Estaría bueno mejorar un poco el estilo de los botones, están como feos: el color y eso."
- "Y lo que está alrededor, ¿harías algo con todo el entorno negro?"

## Alcance autorizado
Tarea E1:
1. **Sistema de diseño en CSS** (variables): paneles tipo vidrio, botones tipo píldora, slider estilizado, tipografía, contraste AA. Los enlaces que funcionan como botones pasan a ser botones reales. Áreas de toque de 44 px como mínimo. Se mantienen las reglas de pointer-events del overlay.
2. **Entorno:**
   - cielo con degradé;
   - laterales de la maqueta (paredes con bandas de tierra hasta una base);
   - bruma atmosférica según la distancia;
   - sombra de contacto (opcional).

   Todo con los recursos GPU creados una sola vez y respetando el render a demanda.

La ficha de lugares queda fuera de alcance: va en `maqueta-lugares-fichas`, en paralelo.

## Feedback adicional de Lautaro (2026-10-03, capturas del iPhone) → tarea E2
1. **Paneles superpuestos:** la leyenda de regiones, los controles y la lista de lugares se pisan entre sí. Hace falta un layout sin superposiciones en celular y en desktop.
2. **Puntos por encima de los paneles:** la capa de lugares tiene un z-index mayor que los paneles. Los marcadores y sus etiquetas tienen que quedar debajo de cualquier panel.
3. **Regiones "difícil de cerrarlo":** hace falta un toggle claro y grande, y la leyenda tiene que poder plegarse o cerrarse fácilmente.
4. **Puntos amarillos feos:** "quiero que quede más lindo". Rediseño de marcadores y etiquetas.
5. **El panel de altura de abajo se encima con "Fuentes de datos".**

## Criterios de aceptación
- Los controles se ven coherentes y prolijos en desktop y en celular, sin tapar el centro del mapa en el teléfono.
- El fondo ya no es negro plano; la maqueta se lee como un objeto con laterales.
- `typecheck`, `test`, `check:wgsl`, `build` y `snapshot` en verde.
- Prueba táctil de Lautaro en el celular.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| E1 | Sistema de diseño + entorno | delegada (Devin) | [x] | Sistema de diseño (tokens CSS, paneles tipo vidrio, píldoras, slider), cielo, laterales de la maqueta, losa y sombra; primer intento con bruma excesiva corregido en E2 |
| E2 | Layout sin superposiciones, z-order de marcadores bajo los paneles, regiones fácil de cerrar, rediseño de marcadores, panel inferior vs atribuciones | delegada (Devin) | [x] | 348 tests; columna #hud sin superposiciones; escala z documentada (marcadores 1 < paneles 5 < hojas 10 < modales 20 < avisos 30); regiones con interruptor y leyenda cerrable; marcadores de 12 px con anillo blanco; bruma relativa a la distancia de cámara (0 en la vista inicial) |
