# Tarea ODD: maqueta-provincia

Locator: `odd/tasks/maqueta-provincia.md` · Engram: `odd/maqueta-provincia/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-provincia` (desde `feat/maqueta-movil`, porque comparte archivos de render y UI)

## Objetivo
Que se vea la forma de Jujuy. El mosaico DEM/satélite es un rectángulo que incluye partes de Bolivia, Chile, Salta y Catamarca.

## Origen
Lautaro (2026-10-03), al ver la v1 en el celular: "pensé que iba a ver algo como la forma de Jujuy al menos". El brief ya lo tenía pendiente: "Falta conseguir: límites departamentales (geoBoundaries ARG ADM2) para recortar la provincia y armar las regiones".

## Fuente (verificada)
- geoBoundaries gbOpen ARG ADM2, release `9469f09`: https://www.geoboundaries.org/api/current/gbOpen/ARG/ADM2/
- Fuente primaria: Instituto Geográfico Nacional y UNHCR, OCHA ROLAC (2020).
- Licencia: **CC BY 3.0 IGO**. El brief suponía CC BY 4.0; se corrige en `ATTRIBUTIONS.md`.
- Se descartó ADM1 de geoBoundaries: su fuente es Wikimedia (2006) y es débil para un sitio educativo.

## Alcance autorizado
1. **P1, datos** (rama/worktree aparte `feat/maqueta-base-t11a`, en paralelo con M1):
   - `fetch:boundaries`: extrae los 16 departamentos sin modificar la geometría, con procedencia y sha256.
   - Rasterizado a índice de departamento por celda y SDF de la provincia (los dos niveles), bbox en `terrain.json` e imagen de control.
   - Atribuciones y tests.
2. **P2, render y UI** (después de M1):
   - Afuera de Jujuy, el terreno oscurecido y desaturado, con el contorno nítido por SDF y toggle "Resaltar Jujuy".
   - Cámara que encuadra la provincia (vertical y horizontal).
   - Etiqueta de calidad sin ambigüedad ("Calidad: normal · Cambiar a alta").
   - "Departamento" en el panel de picking.
   - Atribución de límites visible en la UI.

## Decisiones
- **Extracto en `data/raw/` como entrada fija.** `data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson` es una selección de 16 features del archivo oficial (~70 MB), con la geometría y las propiedades sin modificar, y con su procedencia adentro (URL fija, commit `9469f09`, sha256 del archivo completo, regla de selección). Está commiteado como entrada cruda fija: ningún script escribe en `data/raw/`. `npm run verify:boundaries` descarga el oficial, vuelve a extraer en memoria y verifica que coincida con el archivo commiteado. Así se cumple `AGENTS.md` sin excepciones y no hay que descargar 70 MB en cada build.
- **Nombres de departamentos:** se publican tal como vienen en la fuente (`shapeName`, por ejemplo "Yaví"). La lista del brief solo se usa para verificar que estén los 16.

## Criterios de aceptación
- En la vista inicial (desktop y celular vertical) se reconoce la forma de la provincia, resaltada.
- Los nombres de los departamentos salen de la fuente; nada escrito a mano.
- La atribución de los límites se ve en la página y figura en `ATTRIBUTIONS.md`.
- `build:data` determinista; `typecheck`, `test`, `check:wgsl`, `build` y `snapshot` (incluida una captura vertical) en verde.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| P1 | Datos de límites + rasterizado + SDF | delegada (Devin, worktree aparte) | [x] | `88212e3` (rama feat/maqueta-base-t11a, mergeada); 196 tests; verify:boundaries OK (sha256 y 16/16 idénticos); GGA PASSED al 3º intento (nombres a mano → shapeName; script que escribía en data/raw → verify-only; atribución visible) |
| P2 | Render del contorno + encuadre + UI | delegada (Devin) | [ ] | |

## Próximo paso
Integrar P1 sobre `feat/maqueta-provincia` cuando M1/M2 estén commiteadas; después, P2.
