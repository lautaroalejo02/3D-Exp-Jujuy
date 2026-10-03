# Tarea ODD: maqueta-regiones

Locator: `odd/tasks/maqueta-regiones.md` · Engram: `odd/maqueta-regiones/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-regiones`, que se crea desde la rama vigente cuando arranque la tarea.

## Objetivo
Capa activable con las 4 regiones de Jujuy (Puna, Quebrada, Valles, Yungas/Ramal). Es el punto 2 del alcance v1 del brief.

## Fuente verificada (2026-10-03)
**PIP Jujuy, Programa de Inclusión Socio-Económica en Áreas Rurales (PISEAR).** Ministerio de Agroindustria de la Nación, alojado en magyp.gob.ar:
https://www.magyp.gob.ar/sitio/areas/pisear/institucional/docs/_archivos/000005_PIP%20Jujuy.pdf

Se verificó leyendo el texto extraído del PDF completo con `pdftotext`. No se usaron fragmentos de buscador. Citas textuales:

| Región | Cita | Departamentos |
|---|---|---|
| Puna | "Comprende los departamentos Yavi, Santa Catalina, Rinconada, Cochinoca, Susques, y parte del departamento Humahuaca." | Yavi, Santa Catalina, Rinconada, Cochinoca, Susques |
| Quebrada | "Está conformada por los departamentos Tumbaya, Tilcara y Humahuaca, aunque el territorio de los mismos excede a lo que definimos como Quebrada." | Tumbaya, Tilcara, Humahuaca |
| Valles | "Comprende los departamentos Palpalá, Dr. Manuel Belgrano, San Antonio y El Carmen." | Palpalá, Dr. Manuel Belgrano, San Antonio, El Carmen |
| Ramal (Yungas) | "Incluye los departamentos Ledesma, San Pedro, Santa Bárbara y Valle Grande." | Ledesma, San Pedro, Santa Bárbara, Valle Grande |

Coincide con la agrupación propuesta en el brief.

### Matices que hay que mostrar a los alumnos
Están en la propia fuente y no hay que esconderlos:
- **Humahuaca:** parte de su territorio es Puna.
- **Departamentos de la Quebrada:** su territorio excede a la Quebrada propiamente dicha.
- **Nombre de la cuarta región:** la fuente usa "Ramal". "Yungas" es el nombre ecológico habitual; mostrar los dos ("Yungas (Ramal)").

### Fuente descartada
"Jujuy: Propuesta Estratégica" (argentina.gob.ar): un agente de investigación la citó a partir de fragmentos de buscador, pero el texto completo del PDF **no contiene** esas listas. No se usa.

### Caracterizaciones
Las caracterizaciones por región salen de la sección introductoria del mismo PIP Jujuy, por ejemplo: "La región del altiplano o Puna puede caracterizarse como una meseta alta que supera los 3500msnm…". En la implementación se citan textualmente o se parafrasean de cerca con la fuente al lado. No se agregan números que no estén en la fuente.

## Alcance (propuesto)
1. Tabla departamento → región como dato con fuente (`data/raw/regions-jujuy.json`, escrita a mano a partir de las citas de arriba, con la URL y la cita por región). Validación contra los 16 nombres de la fuente de límites.
2. Pipeline: índice de región por celda, derivado del índice de departamentos.
3. Render: tinte por región en el slot de overlay del shader, capa activable "Regiones", leyenda con nombre y color, bordes entre regiones.
4. Ficha breve por región (texto con fuente) al tocar la leyenda o un punto.
5. Atribuciones: PIP Jujuy en `ATTRIBUTIONS.md` y en la página.

## Matiz conocido
- La fuente nombra al Nevado de Chañi como pico de la Puna, pero el límite departamental (IGN) lo ubica en Dr. Manuel Belgrano (Valles): está sobre el borde. Se mantiene la cita textual; las fichas de lugares deberán explicarlo.

## Criterios de aceptación
- Las 4 regiones se ven y se pueden activar o desactivar.
- Cada dato textual tiene su fuente al lado.
- Los matices de la fuente aparecen en la ficha.
- `typecheck`, `test`, `check:wgsl`, `build` y `snapshot` en verde.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| R0 | Investigación y verificación de la fuente | coordinador | [x] | PIP Jujuy leído completo; Propuesta Estratégica descartada |
| R1 | Datos + pipeline | delegada | [x] | regions-jujuy.json con citas textuales verificadas por test contra el extracto |
| R2 | Render + leyenda + fichas | delegada | [x] | 260 tests; captura regions.png (Okabe–Ito, tinte 0,55); toggle "Regiones" apagado por defecto |
| R3 | Correcciones de GGA: "Sin región asignada" + validación de los 16 departamentos; overlay con nearest; estimación de uniforms | delegada (Devin) | [x] | ver commit |
