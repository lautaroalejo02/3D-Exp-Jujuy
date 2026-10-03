/**
 * Headless terrain snapshots (`npm run snapshot`): renders the same terrain
 * layer the browser app uses — same SceneRenderer, same TerrainLayer — with
 * vgpu's Node adapter (Dawn) into offscreen targets, then writes PNGs to
 * data/build/snapshots/:
 *
 * - overview.png           the app's initial view (province framed, from the south-east)
 * - overview-portrait.png  phone framing: 390x844 CSS px @ DPR 2, mobile mesh
 * - quebrada.png           Humahuaca (see HUMAHUACA) from ~60 km, looking north
 * - quebrada-marker.png    same framing with the pick marker at Humahuaca
 *
 * Data is read from data/build (run `npm run build:data` first). The JPEG is
 * decoded with jpeg-js (the browser uses createImageBitmap instead); .wgsl
 * files are resolved with @vgpu/wgsl/runtime resolveShader.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveShader } from "@vgpu/wgsl/runtime";
import { decode as decodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { frame, init, target } from "vgpu/node";

import { planRender } from "../src/app/device-profile";
import type { Layer } from "../src/app/layers";
import { OrbitCamera } from "../src/camera/camera";
import { bboxOnGrid, overviewCamera } from "../src/camera/framing";
import { createPickMarkerLayer } from "../src/features/pick-marker/pick-marker";
import { lonLatToGrid } from "../src/geo/grid";
import { lonLatToWorld } from "../src/geo/world";
import { createSceneRenderer } from "../src/render/scene-renderer";
import { decodeHeightsLE } from "../src/terrain/encoding";
import { Heightfield } from "../src/terrain/heightfield";
import type { TerrainManifest } from "../src/terrain/manifest";
import {
  createTerrainLayer,
  type MeshSize,
  type ProvinceMask,
} from "../src/terrain/terrain-layer";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_DIR = join(ROOT, "data", "build");
const OUT_DIR = join(BUILD_DIR, "snapshots");

const WIDTH = 1280;
const HEIGHT = 800;
/** Phone screenshot: 390x844 CSS px rendered at DPR 2. */
const PORTRAIT_CSS = [390, 844] as const;
const PORTRAIT_DPR = 2;
const EXAGGERATION = 2.5;

/**
 * Camera framing target for the debug snapshot only (not educational data).
 * Source: Wikidata Q1026833, property P625 (coordinate location),
 * https://www.wikidata.org/wiki/Q1026833
 */
const HUMAHUACA = { lon: -65.35048, lat: -23.20544 } as const;

async function resolveWgsl(file: string): Promise<string> {
  const resolved = await resolveShader({
    entry: join(ROOT, "src", file),
  });
  return resolved.wgsl;
}

async function main(): Promise<void> {
  const manifestPath = join(BUILD_DIR, "terrain.json");
  if (!existsSync(manifestPath)) {
    throw new Error("data/build/terrain.json missing — run npm run build:data");
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as TerrainManifest;
  const level = manifest.levels.default;
  const deptLevel = level.departments;
  if (!deptLevel) {
    throw new Error(
      "terrain.json has no departments data — run npm run build:data",
    );
  }

  const heightfield = new Heightfield(
    decodeHeightsLE(readFileSync(join(BUILD_DIR, level.heights.file))),
    level.heights.grid,
  );
  const provinceMask: ProvinceMask = {
    grid: deptLevel.index.grid,
    // Passing the Buffer to the typed-array constructor copies it, so the
    // result is exact regardless of Buffer pooling.
    index: new Uint8Array(
      readFileSync(join(BUILD_DIR, deptLevel.index.file)),
    ),
    sdf: new Int8Array(readFileSync(join(BUILD_DIR, deptLevel.sdf.file))),
  };
  const jpg = decodeJpeg(readFileSync(join(BUILD_DIR, level.satellite.file)), {
    formatAsRGBA: true,
    useTArray: true,
    maxMemoryUsageInMB: 1024,
  });
  if (
    jpg.width !== level.satellite.grid.width ||
    jpg.height !== level.satellite.grid.height
  ) {
    throw new Error(
      `satellite decoded as ${jpg.width}x${jpg.height}, expected ${level.satellite.grid.width}x${level.satellite.grid.height}`,
    );
  }

  const [terrainWgsl, mipmapWgsl, presentWgsl, markerWgsl] = await Promise.all([
    resolveWgsl(join("terrain", "terrain.wgsl")),
    resolveWgsl(join("render", "mipmap.wgsl")),
    resolveWgsl(join("render", "present.wgsl")),
    resolveWgsl(join("features", "pick-marker", "pick-marker.wgsl")),
  ]);

  const gpu = await init();
  const renderer = createSceneRenderer(gpu, {
    shader: presentWgsl,
    size: [WIDTH, HEIGHT],
    clearColor: [0.1, 0.12, 0.16, 1],
  });
  const output = target(gpu, { size: [WIDTH, HEIGHT], label: "snapshot-out" });
  const portraitSize: [number, number] = [
    PORTRAIT_CSS[0] * PORTRAIT_DPR,
    PORTRAIT_CSS[1] * PORTRAIT_DPR,
  ];
  const portraitRenderer = createSceneRenderer(gpu, {
    shader: presentWgsl,
    size: portraitSize,
    clearColor: [0.1, 0.12, 0.16, 1],
  });
  const portraitOutput = target(gpu, {
    size: portraitSize,
    label: "snapshot-out-portrait",
  });

  const makeTerrain = (mesh?: MeshSize, pixelRatio?: () => number) =>
    createTerrainLayer({
      heightfield,
      satellite: {
        kind: "rgba",
        pixels: jpg.data,
        width: jpg.width,
        height: jpg.height,
      },
      shaders: { terrain: terrainWgsl, mipmap: mipmapWgsl },
      verticalExaggeration: EXAGGERATION,
      provinceMask,
      ...(mesh !== undefined ? { mesh } : {}),
      ...(pixelRatio !== undefined ? { pixelRatio } : {}),
    });
  const terrain = makeTerrain();
  terrain.init({ gpu });
  // The portrait shot uses the mobile profile's mesh, like a phone would.
  const mobileTerrain = makeTerrain(
    planRender("mobile", "default", heightfield.spec).mesh,
    () => PORTRAIT_DPR,
  );
  mobileTerrain.init({ gpu });

  // Pick marker at Humahuaca for the third snapshot: the hit is built like
  // the app's tap path produces it (grid coords + DEM elevation), then the
  // layer's onPick consumes it through the Layer extension point.
  const pickMarker = createPickMarkerLayer({
    spec: heightfield.spec,
    shader: markerWgsl,
    verticalExaggeration: () => EXAGGERATION,
  });
  pickMarker.init({ gpu });
  {
    const elevationMeters = heightfield.heightAtLonLat(
      HUMAHUACA.lon,
      HUMAHUACA.lat,
    );
    if (elevationMeters === undefined) {
      throw new Error("HUMAHUACA falls outside the loaded heightfield");
    }
    const grid = lonLatToGrid(heightfield.spec, HUMAHUACA.lon, HUMAHUACA.lat);
    const world = lonLatToWorld(
      heightfield.spec,
      HUMAHUACA.lon,
      HUMAHUACA.lat,
      { elevationMeters, verticalExaggeration: EXAGGERATION },
    );
    pickMarker.onPick({
      world,
      grid,
      lonLat: [HUMAHUACA.lon, HUMAHUACA.lat],
      elevationMeters,
    });
  }

  const quebradaCamera = (): OrbitCamera => {
    const elevationMeters =
      heightfield.heightAtLonLat(HUMAHUACA.lon, HUMAHUACA.lat) ?? 0;
    const target3 = lonLatToWorld(heightfield.spec, HUMAHUACA.lon, HUMAHUACA.lat, {
      elevationMeters,
      verticalExaggeration: EXAGGERATION,
    });
    // Camera south of the target (azimuth 0) looking north.
    return new OrbitCamera({
      target: target3,
      distanceKm: 60,
      azimuthDeg: 0,
      elevationDeg: 55,
      fovDeg: 45,
      aspect: WIDTH / HEIGHT,
      nearKm: 0.2,
      minDistanceKm: 5,
    });
  };

  // The app's initial view frames the province, not the whole mosaic.
  const provinceRegion = {
    bboxGrid: bboxOnGrid(
      heightfield.spec,
      deptLevel.index.grid,
      deptLevel.provinceBBoxGrid,
    ),
  };
  const relief = {
    maxElevationMeters: heightfield.max,
    verticalExaggeration: EXAGGERATION,
  };

  const shots: {
    name: string;
    camera: OrbitCamera;
    layers: Layer[];
    scene: ReturnType<typeof createSceneRenderer>;
    output: ReturnType<typeof target>;
    size: readonly [number, number];
  }[] = [
    {
      name: "overview",
      camera: overviewCamera(heightfield.spec, WIDTH / HEIGHT, relief, {
        region: provinceRegion,
      }),
      layers: [terrain],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
    },
    {
      name: "overview-portrait",
      camera: overviewCamera(
        heightfield.spec,
        PORTRAIT_CSS[0] / PORTRAIT_CSS[1],
        relief,
        { region: provinceRegion },
      ),
      layers: [mobileTerrain],
      scene: portraitRenderer,
      output: portraitOutput,
      size: portraitSize,
    },
    {
      name: "quebrada",
      camera: quebradaCamera(),
      layers: [terrain],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
    },
    {
      name: "quebrada-marker",
      camera: quebradaCamera(),
      layers: [terrain, pickMarker],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
    },
  ];

  mkdirSync(OUT_DIR, { recursive: true });
  for (const shot of shots) {
    for (const layer of shot.layers) {
      layer.update(
        { time: 0, viewport: shot.size, camera: shot.camera },
        0,
      );
    }
    frame(gpu, (f) => shot.scene.renderFrame(f, shot.output, shot.layers));
    const pixels = await shot.output.color.read({ mipLevel: 0, region: "all" });
    const png = new PNG({ width: shot.size[0], height: shot.size[1] });
    png.data.set(pixels);
    const path = join(OUT_DIR, `${shot.name}.png`);
    writeFileSync(path, PNG.sync.write(png));
    console.log(`wrote ${path}`);
  }

  gpu.dispose();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
