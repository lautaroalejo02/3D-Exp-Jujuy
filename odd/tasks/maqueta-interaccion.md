# Tarea ODD: maqueta-interaccion

Locator: `odd/tasks/maqueta-interaccion.md` · Engram: `odd/maqueta-interaccion/tasks` (proyecto `3d-exp-jujuy`) · Rama: `feat/maqueta-interaccion` (desde `feat/maqueta-provincia` @ `81b057f`)

## Objetivo
Ajustes de lectura y de interacción después de que Lautaro probara la versión con la provincia en su celular.

## Origen
Feedback de Lautaro (2026-10-03):
- "Sacale la opción de resaltar Jujuy, ya que debe ser lo default."
- "Agregale más verticalidad por defecto."
- "No se ven bien ciertas cosas como el Hornocal o las Salinas."
- "Me gustaría que sea más movible; por ahora solo va sobre un eje."

## Alcance autorizado
1. **I1:** quitar el toggle "Resaltar Jujuy": el resaltado queda siempre activo y se elimina el uniform y el código muerto asociados.
2. **I2, más verticalidad:**
   - Exageración inicial de **3x**. Antes era 2,5x; Lautaro sugirió "2 o un poco más", pero 2 aplanaría, y el pedido es más verticalidad.
   - Encuadre vertical menos cenital: elevación de unos 40° en lugar de 60°, manteniendo el ajuste exacto de las 8 esquinas.
3. **I3, Salinas Grandes legible:** quedan sobre el límite con Salta y se veían oscurecidas. Bajar el oscurecido de afuera para que el color y el relieve se sigan leyendo; el contorno sigue marcando el límite.
4. **I4, gestos táctiles como Google Maps:**
   - un dedo pasea;
   - dos dedos hacen pinch para el zoom y twist para rotar;
   - dos dedos deslizando en paralelo en vertical cambian la inclinación.

   Mouse:
   - el botón izquierdo orbita (rota e inclina);
   - el derecho, o Shift/Ctrl más arrastre, pasea;
   - la rueda hace zoom hacia el cursor.

   El rango de inclinación va de 5° a 89°.

Fuera de alcance (tarea aparte, `maqueta-detalle`): parches de alta resolución para el Hornocal y otros lugares (imagen de ~10 m/px y DEM más fino). Hace falta verificar la licencia del nivel de zoom de EOX y las coordenadas con fuente.

## Criterios de aceptación
- No hay toggle; Jujuy siempre resaltado.
- Exageración inicial 3x; en vertical el relieve se lee en 3D desde el arranque (captura vertical).
- Salinas Grandes se reconocen en color, aunque estén fuera del límite (captura cercana).
- Tests del reductor de gestos para: pan con un dedo, pinch, twist, tilt con dos dedos, zoom al cursor y tap (que no se rompa).
- `typecheck`, `test`, `check:wgsl`, `build` y `snapshot` en verde.

## Checklist
| ID | Tarea | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| I1–I4 | Ajustes de lectura + gestos | delegada (Devin swe-2-high) | [x] | 249 tests; capturas: vertical en 3D a 40°, Salinas en color a los dos lados del límite (dimStrength 0,55, desaturación 0,6, oscurecido 0,78) |

## Próximo paso
I1–I4 con Devin; en paralelo, investigar las fuentes para `maqueta-detalle`.
