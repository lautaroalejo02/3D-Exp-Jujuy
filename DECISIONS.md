# Decisiones técnicas: maqueta base (feat/maqueta-base)

Iteración 1. Tarea ODD: `odd/tasks/maqueta-base.md`. Cubre la base de la app; regiones, lugares, perfil y lluvia quedan para las próximas iteraciones.

## Arquitectura

| Módulo | Qué hace | Tipo |
|---|---|---|
| `scripts/build-data.ts` | `data/raw/` → `data/build/`: alturas Int16 (m), satélite, `terrain.json` | Node, determinista |
| `src/geo/` | lat/lon ↔ Web Mercator ↔ píxeles globales ↔ grilla ↔ mundo 3D | Puro + tests |
| `src/terrain/heightfield.ts` | Muestreo bilineal de alturas en metros, `sampleAlong` (base del perfil) | Puro + tests |
| `src/terrain/terrain-layer.ts` + `terrain.wgsl` | Malla desde `vertex_index`, alturas en storage, satélite con mipmaps, iluminación | GPU |
| `src/render/` | Dos pasadas: target con depth + composición al canvas; mipmaps; contabilidad de memoria | GPU |
| `src/camera/` | Cámara orbital (pura), reductor de gestos (puro), adaptador de Pointer Events | Puro + DOM |
| `src/picking/ray.ts` | Rayo de pantalla vs. heightfield en CPU | Puro + tests |
| `src/features/pick-marker/` | Primer `Layer` agregado sobre el terreno: valida el punto de extensión | GPU |
| `src/ui/` | Aviso sin WebGPU, atribuciones, controles, panel de lat/lon/altura | DOM |

### Cómo se enchufan las próximas funcionalidades
Cada una es un `Layer` (`src/app/layers.ts`: `init`, `update`, `draw`, `onPick?`, `ui?`) en `src/features/<nombre>/`, más su script en `scripts/` si necesita datos derivados.
- **Regiones:** un script rasteriza los límites (geoBoundaries ADM2) a una máscara alineada con la grilla. El shader del terreno ya reserva un slot de overlay (textura + opacidad) que hoy está vacío.
- **Lugares:** un JSON con lat/lon y fuente. La altura sale del DEM por script; el marcador reutiliza el patrón de `pick-marker`.
- **Perfil:** dos picks + `Heightfield.sampleAlong()`, que ya está implementado y testeado. Para datos educativos usar la resolución completa (ver precisión abajo).
- **Lluvia:** un script calcula la dirección de escurrimiento D8 desde `heights-full.bin` a `flow.bin`, y una capa de partículas la sigue.

## Decisiones técnicas

- **El DEM se decodifica offline con `pngjs`, nunca con un canvas del navegador.** El manejo de color y el alfa premultiplicado de un canvas pueden alterar los bytes y con eso las alturas.
- **Las alturas se guardan en Int16 little-endian, en metros redondeados.** El error de redondeo máximo es 0,5 m, muy por debajo de la precisión del DEM.
- **Hay dos niveles de calidad (`?calidad=alta`).**
  - Normal: alturas 1216×1280, satélite 2432×2560, malla 608×640.
  - Alta: alturas 2432×2560, satélite 4864×5120, malla 1216×1280.
- **La media resolución es un promedio 2×2 de las alturas en float, antes de redondear.**
- **El mundo 3D usa km de distancia real sobre el terreno.** La escala de Mercator se corrige con cos(latitud central) como un único factor. En un área de unos 340×360 km el error es de ~2 %, y la exageración vertical queda en metros reales.
- **La proyección usa reversed-Z con plano lejano infinito**, para evitar z-fighting en una escena de 400 km. Por eso el picking des-proyecta en dos profundidades finitas: z=0 es el plano en el infinito.
- **El picking se hace en CPU** (rayo marchando sobre el heightfield + bisección), sin leer de vuelta de la GPU. Es testeable, sincrónico y anda igual en celular.
- **Los controles son propios con Pointer Events.** Un reductor puro de gestos tiene 25 tests:
  - un dedo o el botón izquierdo rota; dos dedos pasean, hacen pinch y giran;
  - botón derecho, o Shift/Ctrl más arrastre, pasea; la rueda hace zoom;
  - un tap de menos de 8 px y menos de 350 ms dispara el picking.
- **`data/build/` se sirve con `publicDir` de Vite.** `debug-alignment.png` y `snapshots/` se borran de `dist/` después del build.
- **Las capturas headless (`npm run snapshot`) usan el adaptador Node de vgpu (Dawn)** con el mismo código de render que el navegador. Sirven como evidencia visual en los PR.

## Lo que le faltó a vgpu 0.5 y se hizo a mano

1. **No genera mipmaps.** Se hizo con un dispatch de compute por nivel. Dawn valida el uso por subrecurso: con una vista de lectura que cubre todos los mips, uno de los cuales es el destino de escritura, rechaza el pase. Por eso las dos vistas son de un solo mip.
2. **No tiene controles con paneo ni touch.** `orbitControls` no pasea y no maneja gestos táctiles. Se escribió todo el manejo de entrada.
3. **No trae picking contra un heightfield.** Se implementó en CPU.
4. **Detalles de WebGPU que vgpu no abstrae:**
   - `copyExternalImageToTexture` exige `RENDER_ATTACHMENT` en la textura destino, además de `COPY_DST` y `TEXTURE_BINDING`.
   - Los typed arrays `ArrayBufferLike` necesitan estrecharse a `ArrayBuffer` bajo `strict`.
5. **El loader de Vite viene de `@vgpu/wgsl/loader-vite`**, que es otro paquete. Se declaró como dependencia explícita para no depender de una dependencia transitiva.

## Performance y peso (medido)

### Descarga
Medida en producción (`https://maqueta-jujuy.vercel.app`), transferido con brotli:

| Recurso | Normal | Alta |
|---|---|---|
| Alturas | 2,36 MB | 8,83 MB |
| Satélite (JPEG, sin recomprimir) | 2,49 MB | 7,99 MB |
| JS de la app | ~56 KB | ~56 KB |
| **Total aprox.** | **~4,9 MB** | **~16,9 MB** |

### Memoria GPU
Contabilizada por la app (`getGpuMemoryReport()`):

| Recurso | Normal | Alta |
|---|---|---|
| Satélite + mipmaps (rgba8) | 31,7 MiB | 126,7 MiB |
| Alturas en storage (f32) | 5,9 MiB | 23,8 MiB |
| Color + depth a 1280×800 | ~7,8 MiB | ~7,8 MiB |
| **Total aprox.** | **~45 MiB** | **~158 MiB** |

### Malla
- **Normal:** 2,33 M vértices por draw.
- **Alta:** 9,32 M vértices por draw.

### Pendiente de medir
**No se midieron los FPS en dispositivos reales**: el entorno de trabajo es headless. Hay que medir en una notebook media y en un celular de gama media con WebGPU antes de fijar los criterios del brief (30+ fps). Si el celular no llega:
- bajar la malla de modo normal a 304×320;
- usar el satélite a 1216×1280.

**El modo alta no es para celulares:** ~158 MiB de GPU y ~17 MB de descarga.

### Precisión del modo normal
Error de reconstruir la resolución completa a partir de la media:

| Métrica | Valor |
|---|---|
| Error promedio | 7,45 m |
| Percentil 99 | 40,9 m |
| Máximo (en paredes abruptas) | 501 m |
| Celdas con error mayor a 20 m | 10 % |

El panel de picking muestra el tamaño de celda y el error promedio. **Las alturas educativas (fichas, perfil) tienen que salir de `heights-full.bin` por script**, no del modo normal del cliente.

## Datos: hallazgos

- **Alineación DEM↔satélite: exacta.** La verificaron una imagen de control (`debug-alignment.png`) y una auditoría independiente con Codex:
  - extensión z10 `[82048, 147200, 84480, 149760]` = extensión del satélite z11 / 2;
  - 6,2 M celdas decodificadas sin diferencias.
- **El mínimo del DEM (26 m) es un artefacto:** un pozo de unos 7 píxeles en un entorno de ~300 m, en el borde este. No se modificó. `terrain.json` reporta percentiles robustos: p0,1 % = 285 m y p99,9 % = 5524 m, con un máximo de 6131 m.
- **La licencia de los tiles Terrarium no está declarada en la fuente de atribución.** SRTM, GMTED2010 y ETOPO1 son de dominio público, según https://github.com/tilezen/joerd/blob/master/docs/attribution.md. Queda abierto en `ATTRIBUTIONS.md`.

## Proceso y herramientas

### Quién hizo qué
- **Implementación:** Devin (SWE-2 High).
- **Coordinación y verificación:** Claude.
- **Auditoría independiente:** Codex (GPT-5.6 Sol), sobre la alineación y la matemática geo.

### Revisiones
- **GGA, en el pre-commit:** rechazó tres cosas, todas corregidas:
  - un `catch` vacío;
  - una altura escrita a mano;
  - una coordenada sin fuente (Humahuaca, ahora con Wikidata Q1026833).
- **RDD de Gentle AI:** los candidatos de riesgo medio se saltearon por decisión de Lautaro y se registran en el documento de la tarea para revisarlos después.

### Problemas encontrados
- **El hook de GGA se colgó varias veces** en commits que solo tenían `.md`: un proceso `claude` sin salida. Se resolvió matando el proceso y reintentando con `timeout`.
- **npm 10.9 falló en una instalación en frío** (arborist `edgesOut`). Hizo falta un `--legacy-peer-deps` una sola vez; con el lockfile commiteado, `npm ci` funciona.

## Próximas iteraciones (propuesta)

1. **Medición en dispositivos reales** (corta, antes de seguir): FPS y tiempo de carga en una notebook y un celular. Con eso se fijan la malla y la textura del modo normal, y los criterios de aceptación del brief.
2. **Regiones:** geoBoundaries ADM2 (CC BY 4.0) → máscara por script → overlay en el shader, con capa activable y leyenda. Incluye recortar la provincia.
3. **Lugares:** lista con fuente por coordenada, verificada contra el DEM y el satélite, más fichas con texto fuente. La altura se calcula por script desde la resolución completa.
4. **Perfil de altura:** dos picks, `sampleAlong` sobre la resolución completa (carga diferida de `heights-full.bin`, o el perfil precalculado) y un gráfico en el DOM.
5. **Lluvia:** D8 offline más partículas por GPU siguiendo el flujo y destacado de cuencas.
6. **Mejoras chicas:**
   - headers `Cache-Control: immutable` para los datos (sus nombres o hashes no cambian; hoy salen con `max-age=0`);
   - capturas headless como test visual de regresión;
   - una prueba de humo con navegador.
