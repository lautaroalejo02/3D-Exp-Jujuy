/**
 * Agua mode layer: a GPU rain-particle system over the flow rasters
 * (rain-sim.wgsl advects particles cell to cell through the D8 field,
 * rain-draw.wgsl renders them as bright velocity-aligned streaks), plus
 * an optional basin tint + river-network overlay (basins.wgsl, a second
 * displaced-mesh pass alpha-blended over the terrain).
 *
 * All GPU resources are created once in init(); update() only writes
 * uniforms and dispatches the sim while the mode is active AND playing,
 * so render-on-demand is preserved everywhere else. The flow grid is the
 * half-resolution DEM grid (1216x1280); positions are stored in its
 * cell coords and mapped to world space exactly like the terrain.
 */
import {
  compute,
  draw,
  storage,
  texture,
  type Compute,
  type Draw,
  type Gpu,
  type ShaderSource,
  type StorageBuffer,
  type Texture,
} from "vgpu";

import type { Layer, LayerContext, LayerState } from "../../app/layers";
import {
  buildGpuMemoryReport,
  type GpuMemoryReport,
} from "../../render/gpu-memory";
import type { MeshSize } from "../../terrain/terrain-layer";
import {
  buildTerrainGridUniforms,
  type TerrainGridUniforms,
} from "../../terrain/terrain-uniforms";
import {
  BASIN_COLORS,
  BASINS_LIFT_KM,
  BASINS_OPACITY,
  RAIN_ALPHA,
  RAIN_HALO_SCALE,
  RAIN_LIFE_SECONDS,
  RAIN_LIFT_KM,
  RAIN_SINK_FADE_SECONDS,
  RAIN_SPEED_BASE,
  RAIN_SPEED_GAIN,
  RAIN_TRAIL_CELLS,
  RAIN_WIDTH_CSS_PX,
  RAIN_WORKGROUP_SIZE,
} from "./agua-config";
import type { FlowData } from "./flow-data";
import {
  ACC_LOG2_SCALE,
  BASIN_OUTSIDE,
  buildSpawnCells,
} from "./flow";

export interface AguaLayerShaders {
  /** rain-sim.wgsl (or its resolved WGSL text). */
  readonly sim: string | ShaderSource;
  /** rain-draw.wgsl (or its resolved WGSL text). */
  readonly rain: string | ShaderSource;
  /** basins.wgsl (or its resolved WGSL text). */
  readonly basins: string | ShaderSource;
}

export interface AguaLayerOptions {
  readonly flow: FlowData;
  /**
   * The grid mapping the terrain shader uses (terrain.gridUniforms):
   * supplies the heights-buffer size for bilinear height lookups. The
   * particle world mapping uses the FLOW grid's own spec — both grids
   * cover the same ground extent, so world positions align exactly.
   */
  readonly grid: TerrainGridUniforms;
  /** Terrain's heights storage buffer (bound lazily at init). */
  readonly heights: () => StorageBuffer;
  /** Basin overlay mesh resolution (the terrain's mesh size). */
  readonly mesh: MeshSize;
  readonly shaders: AguaLayerShaders;
  /** Particle cap for this device profile (agua-config.ts budgets). */
  readonly particleBudget: number;
  /**
   * Canvas device-pixel-ratio — droplet widths are specified in CSS px
   * (RAIN_WIDTH_CSS_PX) and converted to physical px here. Defaults to
   * 1 (headless).
   */
  readonly pixelRatio?: () => number;
  /** Live vertical exaggeration (the terrain slider drives the getter). */
  readonly verticalExaggeration: () => number;
  /** True while the Agua mode is the app's active mode. */
  readonly isActive: () => boolean;
  /** Ask the app for another rendered frame (animation driver). */
  readonly requestFrame: () => void;
  /** Initial "Lluvia" play state; default true. */
  readonly initialPlaying?: boolean;
  /** Initial intensity 0..1; default 0.75. */
  readonly initialIntensity?: number;
  /** Start with the basin tint on; default off. */
  readonly initialBasins?: boolean;
}

export interface AguaLayer extends Layer {
  setPlaying(playing: boolean): void;
  setIntensity(value: number): void;
  setBasinsVisible(visible: boolean): void;
  /** Milliseconds of the last sim step (submit → GPU done), if any. */
  lastSimMs(): number | undefined;
  /** Resolves when the last dispatched sim step finished on the GPU. */
  simSettled(): Promise<void>;
  getGpuMemoryReport(): GpuMemoryReport;
}

interface SimParamsValue {
  gridSize: readonly [number, number];
  dt: number;
  frame: number;
  activeCount: number;
  spawnCount: number;
  speedBase: number;
  speedGain: number;
  lifeSeconds: number;
  invAccScale: number;
  sinkFadeSeconds: number;
}

interface RainParamsValue {
  viewProjection: number[];
  originPx: readonly [number, number];
  centerPx: readonly [number, number];
  flowGridSize: readonly [number, number];
  heightsGridSize: readonly [number, number];
  viewportSize: readonly [number, number];
  cellScale: number;
  kmPerPx: number;
  exaggeration: number;
  invAccScale: number;
  widthPx: number;
  haloScale: number;
  trailCells: number;
  liftKm: number;
  lifeSeconds: number;
  alphaScale: number;
}

interface BasinsParamsValue {
  viewProjection: number[];
  originPx: readonly [number, number];
  centerPx: readonly [number, number];
  flowGridSize: readonly [number, number];
  meshSize: readonly [number, number];
  meshToGrid: readonly [number, number];
  heightsGridSize: readonly [number, number];
  cellScale: number;
  kmPerPx: number;
  exaggeration: number;
  liftKm: number;
  opacity: number;
  riverLog: number;
  invAccScale: number;
  basinColors: number[][];
}

/** Deterministic LCG for the initial particle state (tests + snapshots). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function createAguaLayer(opts: AguaLayerOptions): AguaLayer {
  const flowSpec = opts.flow.grid;
  const flowGrid = buildTerrainGridUniforms(flowSpec, [2, 2]);
  const budget = Math.max(1, Math.floor(opts.particleBudget));
  const invAccScale = 1 / ACC_LOG2_SCALE;
  const riverLog = Math.log2(Math.max(1, opts.flow.riverAcc));

  let playing = opts.initialPlaying ?? true;
  let intensity = opts.initialIntensity ?? 0.75;
  let basinsVisible = opts.initialBasins ?? false;
  let activeCount = Math.max(1, Math.round(budget * intensity));

  const simParams: SimParamsValue = {
    gridSize: flowGrid.gridSize,
    dt: 0,
    frame: 0,
    activeCount,
    spawnCount: 0,
    speedBase: RAIN_SPEED_BASE,
    speedGain: RAIN_SPEED_GAIN,
    lifeSeconds: RAIN_LIFE_SECONDS,
    invAccScale,
    sinkFadeSeconds: RAIN_SINK_FADE_SECONDS,
  };
  const pixelRatio = opts.pixelRatio ?? (() => 1);
  const rainParams: RainParamsValue = {
    viewProjection: [
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ],
    originPx: flowGrid.originPx,
    centerPx: flowGrid.centerPx,
    flowGridSize: flowGrid.gridSize,
    heightsGridSize: opts.grid.gridSize,
    viewportSize: [1, 1],
    cellScale: flowGrid.cellScale,
    kmPerPx: flowGrid.kmPerPx,
    exaggeration: opts.verticalExaggeration(),
    invAccScale,
    widthPx: RAIN_WIDTH_CSS_PX * pixelRatio(),
    haloScale: RAIN_HALO_SCALE,
    trailCells: RAIN_TRAIL_CELLS,
    liftKm: RAIN_LIFT_KM,
    lifeSeconds: RAIN_LIFE_SECONDS,
    alphaScale: RAIN_ALPHA,
  };
  const basinsParams: BasinsParamsValue = {
    viewProjection: [
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ],
    originPx: flowGrid.originPx,
    centerPx: flowGrid.centerPx,
    flowGridSize: flowGrid.gridSize,
    meshSize: [opts.mesh.width, opts.mesh.height],
    meshToGrid: [
      flowSpec.width / (opts.mesh.width - 1),
      flowSpec.height / (opts.mesh.height - 1),
    ],
    heightsGridSize: opts.grid.gridSize,
    cellScale: flowGrid.cellScale,
    kmPerPx: flowGrid.kmPerPx,
    exaggeration: opts.verticalExaggeration(),
    liftKm: BASINS_LIFT_KM,
    opacity: BASINS_OPACITY,
    riverLog,
    invAccScale,
    basinColors: BASIN_COLORS.map(([r, g, b], i) => [
      r,
      g,
      b,
      // "otras" reads quieter than the main basins.
      i === 0 ? 0.55 : 1,
    ]),
  };

  let sim: Compute | undefined;
  let rainDraw: Draw | undefined;
  let basinsDraw: Draw | undefined;
  let particlesBuffer: StorageBuffer | undefined;
  let simMs: number | undefined;
  let settle: Promise<void> = Promise.resolve();
  let gpuRef: Gpu | undefined;

  const layer: AguaLayer = {
    id: "agua",

    init(ctx: LayerContext): void {
      const gpu = ctx.gpu;
      gpuRef = gpu;

      // Spawn list: every in-province cell once — uniform over cells is
      // uniform over area (the cells all cover the same ground).
      const inside = Uint8Array.from(opts.flow.basins, (v) =>
        v === BASIN_OUTSIDE ? 0 : 1,
      );
      const spawnCells = buildSpawnCells(
        inside,
        flowSpec.width,
        flowSpec.height,
      );
      if (spawnCells.length === 0) {
        throw new Error("agua: spawn list is empty — no province cells");
      }
      simParams.spawnCount = spawnCells.length;

      // Initial state: particles spread over their whole lifetime so the
      // first frame already shows a developed drainage pattern.
      const rnd = lcg(0x5eed5);
      const state = new Float32Array(budget * 4);
      for (let k = 0; k < budget; k++) {
        const cell =
          spawnCells[Math.floor(rnd() * spawnCells.length)] ?? 0;
        state[k * 4] = (cell % flowSpec.width) + rnd();
        state[k * 4 + 1] = Math.floor(cell / flowSpec.width) + rnd();
        state[k * 4 + 2] = rnd() * RAIN_LIFE_SECONDS;
        state[k * 4 + 3] = rnd() * 1000;
      }
      particlesBuffer = storage(gpu, state.byteLength, "read-write");
      particlesBuffer.write(state);

      const spawnBuffer = storage(gpu, spawnCells.byteLength, "read");
      spawnBuffer.write(
        spawnCells as Uint32Array<ArrayBuffer>,
      );

      // The hydrology rasters as integer textures: sim, droplet and
      // basin shaders all read them with textureLoad — one upload each.
      const uploadU8 = (data: Uint8Array, label: string): Texture => {
        const tex = texture(gpu, {
          kind: "2d",
          size: [flowSpec.width, flowSpec.height],
          format: "r8uint",
          usage: ["texture_binding", "copy_dst"],
          label,
        });
        gpu.gpu.queue.writeTexture(
          { texture: tex.gpu },
          data as Uint8Array<ArrayBuffer>,
          {
            bytesPerRow: flowSpec.width,
            rowsPerImage: flowSpec.height,
          },
          [flowSpec.width, flowSpec.height],
        );
        return tex;
      };
      const dirTex = uploadU8(opts.flow.dir, "flow-dir");
      const basinsTex = uploadU8(opts.flow.basins, "flow-basins");
      const accTex = texture(gpu, {
        kind: "2d",
        size: [flowSpec.width, flowSpec.height],
        format: "r16uint",
        usage: ["texture_binding", "copy_dst"],
        label: "flow-acc",
      });
      gpu.gpu.queue.writeTexture(
        { texture: accTex.gpu },
        opts.flow.accLog2 as Uint16Array<ArrayBuffer>,
        {
          bytesPerRow: flowSpec.width * 2,
          rowsPerImage: flowSpec.height,
        },
        [flowSpec.width, flowSpec.height],
      );

      sim = compute(gpu, opts.shaders.sim, {
        label: "rain-sim",
        set: {
          params: simParams,
          particles: particlesBuffer,
          spawnCells: spawnBuffer,
          flowDirTex: dirTex,
          flowAccTex: accTex,
        },
      });

      rainDraw = draw(gpu, {
        shader: opts.shaders.rain,
        label: "rain",
        vertices: 6,
        instances: activeCount,
        blend: "additive",
        cull: "none",
        // Transparent streaks: test against terrain depth, never write.
        depth: { compare: "greater", write: false },
        set: {
          params: rainParams,
          particles: particlesBuffer,
          heights: opts.heights(),
          flowDirTex: dirTex,
          flowAccTex: accTex,
        },
      });

      const basinVertexCount =
        (opts.mesh.width - 1) * (opts.mesh.height - 1) * 6;
      basinsDraw = draw(gpu, {
        shader: opts.shaders.basins,
        label: "basins",
        vertices: basinVertexCount,
        blend: "alpha",
        cull: "none",
        depth: { compare: "greater", write: false },
        set: {
          params: basinsParams,
          heights: opts.heights(),
          basinsTex,
          flowAccTex: accTex,
        },
      });
    },

    update(state: LayerState, dt: number): void {
      if (!opts.isActive() || !rainDraw || !basinsDraw) return;
      rainParams.viewProjection = state.camera.viewProjectionMatrix();
      rainParams.viewportSize = [state.viewport[0], state.viewport[1]];
      rainParams.exaggeration = opts.verticalExaggeration();
      // CSS-px droplet width -> physical px for THIS canvas's dpr.
      rainParams.widthPx = RAIN_WIDTH_CSS_PX * pixelRatio();
      basinsParams.viewProjection = rainParams.viewProjection;
      basinsParams.exaggeration = rainParams.exaggeration;
      rainDraw.set({
        params: {
          viewProjection: rainParams.viewProjection,
          viewportSize: rainParams.viewportSize,
          exaggeration: rainParams.exaggeration,
          widthPx: rainParams.widthPx,
        },
      });
      if (basinsVisible) {
        basinsDraw.set({
          params: {
            viewProjection: basinsParams.viewProjection,
            exaggeration: basinsParams.exaggeration,
          },
        });
      }

      if (!playing || !sim) return;
      simParams.dt = Math.min(Math.max(dt, 0), 0.1);
      simParams.frame += 1;
      simParams.activeCount = activeCount;
      sim.set({
        params: {
          dt: simParams.dt,
          frame: simParams.frame,
          activeCount: simParams.activeCount,
        },
      });
      const startedAt = performance.now();
      sim.dispatch(Math.ceil(activeCount / RAIN_WORKGROUP_SIZE));
      // onSubmittedWorkDone timing, same approach as the shadow engine —
      // dispatch submits outside the frame so the render-pass timer
      // cannot bracket it.
      settle = (gpuRef?.gpu.queue
        .onSubmittedWorkDone() ?? Promise.resolve())
        .then(() => {
          simMs = performance.now() - startedAt;
        });
      // Particles moved: the mode keeps rendering while it plays.
      opts.requestFrame();
    },

    draw(pass): void {
      if (!opts.isActive()) return;
      if (basinsVisible && basinsDraw) pass.draw(basinsDraw);
      if (rainDraw && activeCount > 0) {
        pass.draw(rainDraw, { instances: activeCount });
      }
    },

    setPlaying(next: boolean): void {
      if (next === playing) return;
      playing = next;
      // On resume the next rendered frame advances the sim; on pause a
      // repaint is still needed only if the state changed on screen —
      // either way one frame keeps things consistent.
      opts.requestFrame();
    },

    setIntensity(value: number): void {
      const v = Math.min(1, Math.max(0.1, value));
      if (v === intensity) return;
      intensity = v;
      activeCount = Math.max(1, Math.round(budget * intensity));
      opts.requestFrame();
    },

    setBasinsVisible(visible: boolean): void {
      if (visible === basinsVisible) return;
      basinsVisible = visible;
      opts.requestFrame();
    },

    lastSimMs(): number | undefined {
      return simMs;
    },

    simSettled(): Promise<void> {
      return settle;
    },

    getGpuMemoryReport(): GpuMemoryReport {
      const cells = flowSpec.width * flowSpec.height;
      return buildGpuMemoryReport([
        {
          label: `rain particles ${budget} x vec4f`,
          bytes: budget * 16,
        },
        {
          label: `flow rasters ${flowSpec.width}x${flowSpec.height} ` +
            `(r8 dir + r8 basins + r16 acc)`,
          bytes: cells + cells + cells * 2,
        },
        {
          label: "rain spawn list (in-province cell indices)",
          bytes: simParams.spawnCount * 4,
        },
      ]);
    },
  };

  return layer;
}
