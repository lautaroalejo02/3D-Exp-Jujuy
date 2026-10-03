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
 * - salinas.png            Salinas Grandes (see SALINAS_GRANDES), the salt
 *                          flat straddling the Salta border — checks the
 *                          outside dimming keeps it readable in color
 * - hornocal.png           Hornocal patch drawn (camera within threshold)
 * - hornocal-base.png      identical framing without the patch layer —
 *                          the before/after evidence for the feature
 * - salinas-detail.png     Salinas Grandes patch drawn
 * - places.png             overview framing with the place markers drawn
 *                          as dots. The app's markers are DOM elements,
 *                          which do not exist headless — the dots use the
 *                          same pure helpers (projection, anchor lift,
 *                          occlusion against the base DEM) so they sit
 *                          where the DOM markers would. Labels/cards are
 *                          DOM-only and not represented here.
 * - purmamarca.png         close view of Purmamarca with its marker dot —
 *                          the coordinate comes from the built
 *                          places.json (OSM override, task A1), so the
 *                          dot must land on the town, not the hill
 * - san-salvador.png       the san-salvador detail patch drawn over the
 *                          city (task A1 — one of the three new sites)
 * - regions.png            overview with the regions layer ON: the four
 *                          PIP Jujuy regions tinted with thin borders
 * - sun-quebrada-sunset.png  quebrada framing, winter solstice ~18:00
 *                          local — low WNW sun, long cast shadows
 * - sun-quebrada-noon.png  same framing at 12:30 local — high sun
 * - sun-overview-morning.png overview framing, winter solstice ~09:00
 *                          local — low ENE sun from the right of frame
 *
 * The run also prints the sun-shadow recompute time (submit → GPU done)
 * for both shadow-quality plans, desktop and mobile.
 *
 * Data is read from data/build (run `npm run build:data` and
 * `npm run build:detail` first). The JPEG is decoded with jpeg-js (the
 * browser uses createImageBitmap instead); .wgsl files are resolved with
 * @vgpu/wgsl/runtime resolveShader.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveShader } from "@vgpu/wgsl/runtime";
import { decode as decodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { frame, init, target } from "vgpu/node";

import { planRender, planShadows } from "../src/app/device-profile";
import type { Layer } from "../src/app/layers";
import { OrbitCamera } from "../src/camera/camera";
import { bboxOnGrid, overviewCamera } from "../src/camera/framing";
import {
  createDetailLayer,
  type DetailLayer,
  type DetailSiteData,
} from "../src/features/detail/detail-layer";
import { createPickMarkerLayer } from "../src/features/pick-marker/pick-marker";
import {
  isOccluded,
  MARKER_LIFT_METERS,
  projectToScreen,
} from "../src/features/places/places-markers";
import { lonLatToGrid } from "../src/geo/grid";
import { gridToWorld, lonLatToWorld } from "../src/geo/world";
import { createSceneRenderer } from "../src/render/scene-renderer";
import type { DepartmentInfo } from "../src/terrain/departments";
import { buildDetailPatchRects } from "../src/terrain/detail-grids";
import {
  assertDetailSatelliteSize,
  loadDetailManifest,
  loadDetailSite,
  type DetailSite,
} from "../src/terrain/detail-manifest";
import { decodeHeightsLE } from "../src/terrain/encoding";
import {
  Heightfield,
  type FetchResponseLike,
} from "../src/terrain/heightfield";
import type { TerrainManifest } from "../src/terrain/manifest";
import { loadPlaces, type PlacesDoc } from "../src/terrain/places-manifest";
import { createDioramaLayer, type DioramaLayer } from "../src/terrain/diorama";
import { argentinaLocalToUtc, sunLook } from "../src/sun/solar";
import {
  buildDepartmentToRegion,
  buildRegionOverlay,
  parseRegions,
} from "../src/terrain/regions";
import {
  createTerrainLayer,
  DEFAULT_VERTICAL_EXAGGERATION,
  type MeshSize,
  type ProvinceMask,
  type TerrainLayer,
} from "../src/terrain/terrain-layer";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_DIR = join(ROOT, "data", "build");
const OUT_DIR = join(BUILD_DIR, "snapshots");

const WIDTH = 1280;
const HEIGHT = 800;
/** Phone screenshot: 390x844 CSS px rendered at DPR 2. */
const PORTRAIT_CSS = [390, 844] as const;
const PORTRAIT_DPR = 2;
const EXAGGERATION = DEFAULT_VERTICAL_EXAGGERATION;

/**
 * Camera framing target for the debug snapshot only (not educational data).
 * Source: Wikidata Q1026833, property P625 (coordinate location),
 * https://www.wikidata.org/wiki/Q1026833
 */
const HUMAHUACA = { lon: -65.35048, lat: -23.20544 } as const;

/**
 * Camera target for the Salinas Grandes snapshot (the salt flat straddles
 * the Jujuy/Salta border, so half of it sits in the dimmed outside).
 * Source: Wikidata Q2893104 "Salinas Grandes" (salt flats in the provinces
 * of Jujuy and Salta), property P625 (coordinate location),
 * https://www.wikidata.org/wiki/Q2893104
 */
const SALINAS_GRANDES = { lon: -65.894441666667, lat: -23.63325 } as const;

/**
 * Camera framing target for the Purmamarca snapshot (not educational
 * data; the marker dot itself comes from the built places.json).
 * Source: OpenStreetMap relation/4473250 "Purmamarca" via Nominatim
 * (ODbL, © OpenStreetMap contributors),
 * https://www.openstreetmap.org/relation/4473250 — the same override
 * data/raw/places/osm-coordinates.json records.
 */
const PURMAMARCA = { lon: -65.4992167, lat: -23.74655 } as const;

/**
 * Solar reference point for the sun shots: San Salvador de Jujuy — the
 * same coordinate the solar unit tests are checked against (Wikidata
 * P625 of Q44217). The sun direction is practically constant across the
 * province, so one coordinate drives every sun shot.
 */
const JUJUY_SOLAR = { lat: -24.1856, lon: -65.2994 } as const;

/**
 * FetchLike over data/build/: lets the headless script reuse the same
 * manifest/site loaders the browser runs (detail/manifest.json and the
 * per-site payloads).
 */
const fileFetch = (url: string): Promise<FetchResponseLike> => {
  const path = join(BUILD_DIR, url);
  if (!existsSync(path)) {
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve(undefined),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  }
  const bytes = readFileSync(path);
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(JSON.parse(bytes.toString("utf8")) as unknown),
    // Buffer's underlying ArrayBuffer can be pooled — slice to the exact
    // file bytes.
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      ),
  });
};

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
  const boundaries = manifest.boundaries;
  if (!deptLevel || !boundaries) {
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

  // Regions overlay: departments.json names → region index → RGBA tint
  // raster, same construction the app runs on the CPU before upload.
  const regionsData = parseRegions(
    JSON.parse(
      readFileSync(join(ROOT, "data", "raw", "regions-jujuy.json"), "utf8"),
    ),
  );
  const departmentsMeta = JSON.parse(
    readFileSync(join(BUILD_DIR, boundaries.file.file), "utf8"),
  ) as { departments: DepartmentInfo[] };
  const deptToRegion = buildDepartmentToRegion(
    regionsData,
    departmentsMeta.departments,
  );
  const regionOverlay = {
    grid: deptLevel.index.grid,
    rgba: buildRegionOverlay(provinceMask.index, deptToRegion, regionsData),
  };

  const [terrainWgsl, mipmapWgsl, presentWgsl, markerWgsl, detailWgsl, dioramaWgsl, shadowWgsl] =
    await Promise.all([
      resolveWgsl(join("terrain", "terrain.wgsl")),
      resolveWgsl(join("render", "mipmap.wgsl")),
      resolveWgsl(join("render", "present.wgsl")),
      resolveWgsl(join("features", "pick-marker", "pick-marker.wgsl")),
      resolveWgsl(join("features", "detail", "detail.wgsl")),
      resolveWgsl(join("terrain", "diorama.wgsl")),
      resolveWgsl(join("sun", "shadow.wgsl")),
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

  // Detail patches (data/build/detail/). Site coordinates come from the
  // manifest — the same sourced values the app loads — never hand-written.
  // Loaded before the terrain layer: the base discard rects are computed
  // from the same site specs and handed to both layers.
  let detailLayer: DetailLayer | undefined;
  const detailSiteData = new Map<string, DetailSiteData>();
  let detailSites: DetailSiteData[] = [];
  if (existsSync(join(BUILD_DIR, "detail", "manifest.json"))) {
    const detailManifest = await loadDetailManifest(fileFetch);
    detailSites = await Promise.all(
      detailManifest.sites.map(async (site) => {
        const payload = await loadDetailSite(site, fileFetch, "detail/");
        const img = decodeJpeg(payload.satelliteBytes, {
          formatAsRGBA: true,
          useTArray: true,
          maxMemoryUsageInMB: 256,
        });
        assertDetailSatelliteSize(site, img.width, img.height);
        const data: DetailSiteData = {
          site,
          heightfield: payload.heightfield,
          satellite: {
            kind: "rgba",
            pixels: img.data,
            width: img.width,
            height: img.height,
          },
        };
        detailSiteData.set(site.id, data);
        return data;
      }),
    );
  } else {
    console.warn(
      "data/build/detail/manifest.json missing — detail snapshots " +
        "skipped (run npm run build:detail)",
    );
  }
  // Place markers for places.png. Additive like the detail data: a
  // missing/invalid places.json only means the shot has no dots.
  let placesDoc: PlacesDoc | undefined;
  try {
    placesDoc = await loadPlaces(fileFetch);
  } catch (error) {
    console.warn(
      "data/build/places.json unavailable — places.png will have no " +
        `marker dots (run npm run build:places): ${
          error instanceof Error ? error.message : error
        }`,
    );
  }

  const patchRects = buildDetailPatchRects(
    detailSites.map((d) => ({ id: d.site.id, spec: d.heightfield.spec })),
    heightfield.spec,
  );

  const makeTerrain = (
    mesh?: MeshSize,
    pixelRatio?: () => number,
    shadows?: { readonly shader: string; readonly plan: ReturnType<typeof planShadows> },
  ) =>
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
      detailPatches: patchRects,
      regionOverlay,
      ...(mesh !== undefined ? { mesh } : {}),
      ...(pixelRatio !== undefined ? { pixelRatio } : {}),
      ...(shadows !== undefined ? { shadows } : {}),
    });
  const terrain = makeTerrain();
  terrain.init({ gpu });

  // Sites whose patch currently covers the base (loaded AND in range) —
  // mirrored into the terrain's discard mask by the detail layer.
  const coveringIds = new Set<string>();
  if (detailSites.length > 0) {
    detailLayer = createDetailLayer({
      baseSpec: heightfield.spec,
      baseSurface: {
        grid: terrain.gridUniforms,
        heights: () => terrain.baseHeightsStorage(),
      },
      sites: detailSites,
      shaders: { detail: detailWgsl, mipmap: mipmapWgsl },
      verticalExaggeration: () => EXAGGERATION,
      onCoveringChange: (ids) => {
        coveringIds.clear();
        for (const id of ids) coveringIds.add(id);
        terrain.setDetailPatchMask(coveringIds);
      },
    });
    detailLayer.init({ gpu });
  }

  /**
   * Camera framed on a detail site's sourced coordinates, close enough to
   * be within the patch draw threshold (distance factor must stay below
   * the layer's DETAIL_DRAW_DISTANCE_FACTOR).
   */
  const detailCamera = (
    siteId: string,
    azimuthDeg: number,
    elevationDeg: number,
    distanceFactor = 1.6,
  ): OrbitCamera => {
    const data = detailSiteData.get(siteId);
    if (!data) {
      throw new Error(`detail site "${siteId}" not in the manifest`);
    }
    const site: DetailSite = data.site;
    const elevationMeters =
      data.heightfield.heightAtLonLat(site.lon, site.lat) ?? 0;
    const target3 = lonLatToWorld(heightfield.spec, site.lon, site.lat, {
      elevationMeters,
      verticalExaggeration: EXAGGERATION,
    });
    return new OrbitCamera({
      target: target3,
      distanceKm: Math.max(site.sizeKm[0], site.sizeKm[1]) * distanceFactor,
      azimuthDeg,
      elevationDeg,
      fovDeg: 45,
      aspect: WIDTH / HEIGHT,
      nearKm: 0.2,
      minDistanceKm: 5,
    });
  };

  // The portrait shot uses the mobile profile's mesh, like a phone would.
  const mobileTerrain = makeTerrain(
    planRender("mobile", "default", heightfield.spec).mesh,
    () => PORTRAIT_DPR,
  );
  mobileTerrain.init({ gpu });
  // Regions shot: same terrain with the overlay bound and visible from
  // the start (the app's toggle only flips the same two uniforms).
  const regionsTerrain = makeTerrain();
  regionsTerrain.init({ gpu });
  regionsTerrain.setRegionsVisible(true);

  // Diorama surroundings: sky + walls + slab, drawn first so its backdrop
  // sits behind the terrain. One per mesh variant — the walls follow the
  // mesh edge resolution.
  const makeDiorama = (t: TerrainLayer) =>
    createDioramaLayer({
      grid: t.gridUniforms,
      heights: () => t.baseHeightsStorage(),
      minElevationMeters: heightfield.min,
      verticalExaggeration: () => EXAGGERATION,
      shader: dioramaWgsl,
      shadowTexture: () => t.shadowTexture(),
    });
  const diorama = makeDiorama(terrain);
  diorama.init({ gpu });
  const mobileDiorama = makeDiorama(mobileTerrain);
  mobileDiorama.init({ gpu });

  // Sun shots get their own terrain+diorama pair with the shadow engine
  // at the DESKTOP quality plan — leaving the shared `terrain` on the
  // shipped default look so the other snapshots are untouched. The
  // mobile-plan engine is created only to time its recompute.
  const sunTerrain = makeTerrain(undefined, undefined, {
    shader: shadowWgsl,
    plan: planShadows("desktop"),
  });
  sunTerrain.init({ gpu });
  const sunDiorama = makeDiorama(sunTerrain);
  sunDiorama.init({ gpu });
  const sunMobileTerrain = makeTerrain(undefined, undefined, {
    shader: shadowWgsl,
    plan: planShadows("mobile"),
  });
  sunMobileTerrain.init({ gpu });

  /**
   * Push one sun instant into the sun layers and wait for the shadow
   * recompute to finish on the GPU — the shots render after this, so the
   * visibility texture is current (it is a plain texture when sampled).
   */
  const applySun = async (
    utc: Date,
    t: TerrainLayer,
    d: DioramaLayer,
  ): Promise<void> => {
    const look = sunLook(utc, JUJUY_SOLAR.lat, JUJUY_SOLAR.lon);
    t.setSun(look.direction, look.sunColor, look.ambientColor);
    t.setShadowsEnabled(true);
    d.setSun(look.direction, look.sunColor, look.ambientColor);
    d.setShadowsEnabled(true);
    d.setSkyTint(look.skyTint);
    await t.shadowSettled();
  };

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

  /**
   * Filled disc into the PNG pixels — the stand-in for the DOM marker
   * dot (white ring + soft blue fill, same look as .place-marker-dot).
   */
  const stampDisc = (
    png: PNG,
    cx: number,
    cy: number,
    radius: number,
    rgb: readonly [number, number, number],
  ): void => {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(png.width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(png.height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        const o = (y * png.width + x) * 4;
        png.data[o] = rgb[0];
        png.data[o + 1] = rgb[1];
        png.data[o + 2] = rgb[2];
        png.data[o + 3] = 255;
      }
    }
  };

  /**
   * Where the DOM marker of each place would land, headless: world anchor
   * on the base DEM with the same lift, projected with the shot's camera,
   * skipped when off-screen or occluded (isOccluded, base DEM only — the
   * patch blend is not geomorphed here). Dots only: no labels or cards.
   */
  const drawPlaceDots = (
    png: PNG,
    camera: OrbitCamera,
    onlyPlaceId?: string,
  ): void => {
    if (!placesDoc) return;
    const viewProjection = camera.viewProjectionMatrix();
    const eye = camera.eye();
    for (const place of placesDoc.places) {
      if (onlyPlaceId !== undefined && place.id !== onlyPlaceId) continue;
      const [i, j] = lonLatToGrid(heightfield.spec, place.lon, place.lat);
      const elevationMeters = heightfield.heightAtGrid(i, j);
      const world = gridToWorld(heightfield.spec, i, j, {
        elevationMeters: elevationMeters + MARKER_LIFT_METERS,
        verticalExaggeration: EXAGGERATION,
      });
      const p = projectToScreen(viewProjection, world, [WIDTH, HEIGHT]);
      if (
        !p ||
        p.x < 0 ||
        p.x >= WIDTH ||
        p.y < 0 ||
        p.y >= HEIGHT ||
        isOccluded(heightfield, eye, world, EXAGGERATION)
      ) {
        continue;
      }
      stampDisc(png, p.x, p.y, 6, [248, 249, 251]);
      stampDisc(png, p.x, p.y, 4, [123, 167, 222]);
    }
  };

  /**
   * Close-up of Purmamarca from the east — the Quebrada de Purmamarca
   * opens toward the Quebrada de Humahuaca in that direction, so the
   * town reads against the siete-colores slope behind it; inside the
   * patch's draw distance, so the shot also shows the detail layer.
   * The marker dot stamps the place's coordinate from places.json (the
   * OSM override), which must sit on the town.
   */
  const purmamarcaCamera = (): OrbitCamera => {
    const elevationMeters =
      heightfield.heightAtLonLat(PURMAMARCA.lon, PURMAMARCA.lat) ?? 0;
    const target3 = lonLatToWorld(
      heightfield.spec,
      PURMAMARCA.lon,
      PURMAMARCA.lat,
      { elevationMeters, verticalExaggeration: EXAGGERATION },
    );
    return new OrbitCamera({
      target: target3,
      distanceKm: 14,
      azimuthDeg: 100,
      elevationDeg: 35,
      fovDeg: 45,
      aspect: WIDTH / HEIGHT,
      nearKm: 0.2,
      minDistanceKm: 5,
    });
  };

  const shots: {
    name: string;
    camera: OrbitCamera;
    layers: Layer[];
    scene: ReturnType<typeof createSceneRenderer>;
    output: ReturnType<typeof target>;
    size: readonly [number, number];
    /** Runs before the layer updates (sun shots push their instant here). */
    prepare?: () => Promise<void>;
    drawExtras?: (png: PNG, camera: OrbitCamera) => void;
  }[] = [
    {
      name: "overview",
      camera: overviewCamera(heightfield.spec, WIDTH / HEIGHT, relief, {
        region: provinceRegion,
      }),
      layers: [diorama, terrain],
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
      layers: [mobileDiorama, mobileTerrain],
      scene: portraitRenderer,
      output: portraitOutput,
      size: portraitSize,
    },
    {
      name: "quebrada",
      camera: quebradaCamera(),
      layers: [diorama, terrain],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
    },
    {
      name: "quebrada-marker",
      camera: quebradaCamera(),
      layers: [diorama, terrain, pickMarker],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
    },
    // Sun engine (task S2a): winter solstice 2026-06-21 at two hours.
    // 18:00 local is ~44 min before sunset — a ~8 deg sun from the WNW
    // throwing long shadows; 12:30 is the ~41 deg midday sun.
    {
      name: "sun-quebrada-sunset",
      camera: quebradaCamera(),
      layers: [sunDiorama, sunTerrain],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
      prepare: () =>
        applySun(
          argentinaLocalToUtc(2026, 6, 21, 18, 0),
          sunTerrain,
          sunDiorama,
        ),
    },
    {
      name: "sun-quebrada-noon",
      camera: quebradaCamera(),
      layers: [sunDiorama, sunTerrain],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
      prepare: () =>
        applySun(
          argentinaLocalToUtc(2026, 6, 21, 12, 30),
          sunTerrain,
          sunDiorama,
        ),
    },
    {
      name: "sun-overview-morning",
      camera: overviewCamera(heightfield.spec, WIDTH / HEIGHT, relief, {
        region: provinceRegion,
      }),
      layers: [sunDiorama, sunTerrain],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
      prepare: () =>
        applySun(
          argentinaLocalToUtc(2026, 6, 21, 9, 0),
          sunTerrain,
          sunDiorama,
        ),
    },
    {
      name: "regions",
      camera: overviewCamera(heightfield.spec, WIDTH / HEIGHT, relief, {
        region: provinceRegion,
      }),
      layers: [diorama, regionsTerrain],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
    },
    {
      name: "salinas",
      camera: (() => {
        const elevationMeters =
          heightfield.heightAtLonLat(
            SALINAS_GRANDES.lon,
            SALINAS_GRANDES.lat,
          ) ?? 0;
        const target3 = lonLatToWorld(
          heightfield.spec,
          SALINAS_GRANDES.lon,
          SALINAS_GRANDES.lat,
          { elevationMeters, verticalExaggeration: EXAGGERATION },
        );
        // From the north-west looking south-east, so the boundary outline
        // crosses the salt flat inside the frame.
        return new OrbitCamera({
          target: target3,
          distanceKm: 70,
          azimuthDeg: 310,
          elevationDeg: 50,
          fovDeg: 45,
          aspect: WIDTH / HEIGHT,
          nearKm: 0.2,
          minDistanceKm: 5,
        });
      })(),
      layers: [diorama, terrain],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
    },
    // Detail patch evidence: before/after on Hornocal, plus the Salinas
    // patch. Skipped entirely when data/build/detail/ is missing.
    ...(detailLayer
      ? ([
          {
            name: "hornocal",
            camera: detailCamera("hornocal", 20, 45),
            layers: [diorama, terrain, detailLayer],
            scene: renderer,
            output,
            size: [WIDTH, HEIGHT] as const,
          },
          {
            name: "hornocal-base",
            camera: detailCamera("hornocal", 20, 45),
            layers: [diorama, terrain],
            scene: renderer,
            output,
            size: [WIDTH, HEIGHT] as const,
          },
          {
            name: "salinas-detail",
            camera: detailCamera("salinas-grandes", 300, 50),
            layers: [diorama, terrain, detailLayer],
            scene: renderer,
            output,
            size: [WIDTH, HEIGHT] as const,
          },
          // Task A1: the new San Salvador patch over the city.
          {
            name: "san-salvador",
            camera: detailCamera("san-salvador", 150, 45),
            layers: [diorama, terrain, detailLayer],
            scene: renderer,
            output,
            size: [WIDTH, HEIGHT] as const,
          },
          // Task A1: the OSM-corrected Purmamarca marker must land on the
          // town, not inside the mountain the coarse Wikidata P625 put it
          // on. The dot comes from the built places.json, not the
          // hardcoded camera target.
          {
            name: "purmamarca",
            camera: purmamarcaCamera(),
            layers: [diorama, terrain, detailLayer],
            scene: renderer,
            output,
            size: [WIDTH, HEIGHT] as const,
            drawExtras: (png: PNG, camera: OrbitCamera) =>
              drawPlaceDots(png, camera, "Q1025405"),
          },
        ] satisfies {
          name: string;
          camera: OrbitCamera;
          layers: Layer[];
          scene: ReturnType<typeof createSceneRenderer>;
          output: ReturnType<typeof target>;
          size: readonly [number, number];
          drawExtras?: (png: PNG, camera: OrbitCamera) => void;
        }[])
      : []),
    {
      name: "places",
      camera: overviewCamera(heightfield.spec, WIDTH / HEIGHT, relief, {
        region: provinceRegion,
      }),
      layers: [diorama, terrain],
      scene: renderer,
      output,
      size: [WIDTH, HEIGHT],
      drawExtras: drawPlaceDots,
    },
  ];

  mkdirSync(OUT_DIR, { recursive: true });
  for (const shot of shots) {
    await shot.prepare?.();
    // The discard mask must match THIS shot's layers: a shot without the
    // detail layer would otherwise inherit the previous shot's mask and
    // leave a hole in the base terrain.
    if (shot.layers.includes(terrain)) {
      terrain.setDetailPatchMask(
        detailLayer && shot.layers.includes(detailLayer)
          ? coveringIds
          : new Set(),
      );
    }
    for (const layer of shot.layers) {
      layer.update(
        { time: 0, viewport: shot.size, camera: shot.camera },
        0,
      );
    }
    // The detail layer's update() only enqueues GPU work for an async
    // loader (resources are never created inside update/draw). Await it,
    // then update once more so the just-created draws get their uniforms.
    if (detailLayer && shot.layers.includes(detailLayer)) {
      await detailLayer.whenSettled();
      detailLayer.update(
        { time: 0, viewport: shot.size, camera: shot.camera },
        0,
      );
    }
    frame(gpu, (f) => shot.scene.renderFrame(f, shot.output, shot.layers));
    const pixels = await shot.output.color.read({ mipLevel: 0, region: "all" });
    const png = new PNG({ width: shot.size[0], height: shot.size[1] });
    png.data.set(pixels);
    shot.drawExtras?.(png, shot.camera);
    const path = join(OUT_DIR, `${shot.name}.png`);
    writeFileSync(path, PNG.sync.write(png));
    console.log(`wrote ${path}`);
  }

  // Shadow-engine cost evidence for both quality plans (task S2a): the
  // desktop plan ran with the sun shots; run one recompute on the mobile
  // plan here so both timings print.
  {
    const look = sunLook(
      argentinaLocalToUtc(2026, 6, 21, 18, 0),
      JUJUY_SOLAR.lat,
      JUJUY_SOLAR.lon,
    );
    sunMobileTerrain.setSun(look.direction, look.sunColor, look.ambientColor);
    sunMobileTerrain.setShadowsEnabled(true);
    await sunMobileTerrain.shadowSettled();
    const fmt = (v: number | undefined): string =>
      v === undefined ? "n/a" : `${v.toFixed(1)} ms`;
    const desktopPlan = planShadows("desktop");
    const mobilePlan = planShadows("mobile");
    console.log(
      `sun-shadow recompute (desktop ${desktopPlan.width}x${desktopPlan.height}, ` +
        `${desktopPlan.steps} steps): ${fmt(sunTerrain.shadowMs())}`,
    );
    console.log(
      `sun-shadow recompute (mobile ${mobilePlan.width}x${mobilePlan.height}, ` +
        `${mobilePlan.steps} steps): ${fmt(sunMobileTerrain.shadowMs())}`,
    );
  }

  gpu.dispose();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
