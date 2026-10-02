# Brief: Maqueta 3D de Jujuy (entrada para /sdd-new)

## Qué es
Una web para que chicos de secundaria aprendan la geografía de Jujuy explorando una maqueta 3D del relieve real con imagen satelital. Se ven las 4 regiones, los lugares importantes con una ficha educativa, el perfil de altura entre dos puntos y una simulación simplificada de lluvia que muestra cómo escurre el agua y qué es una cuenca.

## Decisiones tomadas (no reabrir sin motivo)
- Audiencia: secundaria. Textos claros y correctos, pueden incluir datos (altura, clima, pisos de vegetación, actividades).
- Alcance v1:
  1. Maqueta 3D: relieve real + satélite, rotar / acercar / desplazar con mouse y touch.
  2. Regiones: Puna, Quebrada, Valles y Yungas, activables como capa.
  3. Lugares: marcadores clickeables con ficha (nombre, región, altura, descripción breve, fuente).
  4. Perfil de altura: el usuario marca dos puntos y ve el corte del terreno.
  5. Lluvia simplificada: dirección de escurrimiento precalculada (offline) y partículas animadas que la siguen.
- Fuera de v1: juego "¿Dónde queda?", lluvia simulada en GPU en tiempo real, otras provincias, modo offline, renderer alternativo.
- Motor: vgpu (WebGPU, TypeScript). Sin WebGPU se muestra solo un aviso claro (decisión consciente: en muchos celulares la v1 no va a andar).
- Dispositivos: PC y celular por igual donde haya WebGPU. Controles táctiles desde el día 1.
- Deploy: sitio estático público (Vercel o GitHub Pages), sin backend.
- Contenido: cada dato educativo lleva fuente citada. Un agente verificador lo cruza y Lautaro aprueba al final. Las alturas se calculan del DEM, no se escriben de memoria.

## Datos ya descargados (en Descargas)
- `jujuy_terrarium_z10_x320-329_y575-584.png`: DEM Terrarium (Mapzen/AWS), mosaico 2560x2560 de tiles z10, x 320..329, y 575..584, Web Mercator. Altura = R*256 + G + B/256 - 32768 (metros).
- `jujuy_s2cloudless2016_z11_x641-659_y1150-1169.jpg`: Sentinel-2 cloudless 2016 de EOX, mosaico 4864x5120 de tiles z11, x 641..659, y 1150..1169, Web Mercator. Licencia CC BY 4.0. Atribución: "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)".
- Los dos mosaicos no cubren exactamente la misma zona: alinearlos con los números de tile y zoom.
- Falta conseguir: límites departamentales (geoBoundaries ARG ADM2, CC BY 4.0) para recortar la provincia y armar las regiones.

## Regiones (división habitual por departamentos, a verificar con fuente)
- Puna: Yavi, Santa Catalina, Rinconada, Cochinoca, Susques.
- Quebrada: Humahuaca, Tilcara, Tumbaya.
- Valles: Dr. Manuel Belgrano, Palpalá, El Carmen, San Antonio.
- Yungas: Ledesma, San Pedro, Santa Bárbara, Valle Grande.

## Lugares candidatos (coordenadas y textos a verificar)
- Quebrada: Purmamarca y Cerro de los Siete Colores, Maimará (Paleta del Pintor), Tilcara (Pucará), Uquía, Humahuaca, Serranía de Hornocal.
- Puna: Salinas Grandes, Laguna de Guayatayoc, Laguna de Pozuelos, Abra Pampa, La Quiaca, Yavi, Susques.
- Yungas: Parque Nacional Calilegua, Libertador General San Martín, San Pedro, Valle Grande.
- Valles: San Salvador de Jujuy, Palpalá, Yala, Termas de Reyes, Dique La Ciénaga.
- Cumbres: Nevado de Chañi.

## Notas técnicas de vgpu 0.5.0
- Documentación local: `npx vgpu docs cat getting-started.md`, `two-pass-rendering.md`, `concepts-draws.md`.
- 3D: render en `target(gpu, { depth: true })` y composición al canvas con un `effect` (dos pasadas en un `frame`).
- El relieve puede ir en `storage(gpu, bytes, "read")` y la malla generarse en el vertex shader desde `vertex_index`.
- Para texturas propias: `texture(gpu, {...usage: ["texture_binding","copy_dst"]})` y subir datos con `gpu.device.gpu.queue.writeTexture`.
- `orbitControls` de `vgpu/scene` no tiene paneo y no está claro el soporte táctil: probablemente haga falta controles propios (rotar, paneo, zoom, pinch).
- Validación headless: `npx vgpu doctor`; renderizar a target y leer píxeles para tests.

## Criterios de aceptación de alto nivel
- Carga en menos de X s en notebook media (definir X en spec).
- 30+ fps en notebook media y en un celular de gama media con WebGPU (definir dispositivos de prueba).
- Sin WebGPU: aviso visible, sin pantalla en blanco ni errores.
- Todo lugar y región tiene fuente verificada; ninguna altura escrita a mano.
- Atribuciones de datos visibles en la página.

## Preguntas abiertas para explore
- Lista final de lugares y nivel de detalle de cada ficha.
- Valores concretos de performance y dispositivos de prueba.
- Cómo presentar la lluvia para que se entienda qué es una cuenca (¿destacar cuencas principales?).
- Estrategia de tamaño de assets (resolución de malla y textura, compresión) para que cargue en celular.
