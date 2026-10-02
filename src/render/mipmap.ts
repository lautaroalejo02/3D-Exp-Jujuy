import {
  compute,
  sampler,
  type Gpu,
  type ShaderSource,
  type Texture,
} from "vgpu";

import { mipLevelCount } from "./gpu-memory";

/**
 * vgpu has no mip-generation helper, so mip levels are filled by hand: one
 * compute dispatch per level bilinearly downsamples the previous level.
 * Both `src` and `dst` bind single-mip views created with
 * `texture.createView(...)`: WebGPU validates usage per subresource, and
 * Dawn rejects a sampled view covering every mip while one of them is the
 * storage-write target.
 *
 * Call once at init, after mip 0 has been uploaded. The dispatches submit
 * in order, so each level reads a fully-written previous level.
 */
export function generateMipmaps(
  gpu: Gpu,
  shader: string | ShaderSource,
  tex: Texture,
): void {
  const levels = tex.mipLevelCount;
  if (levels <= 1) return;
  const linear = sampler(gpu, {
    minFilter: "linear",
    magFilter: "linear",
    mipmapFilter: "linear",
  });
  const mip = compute(gpu, shader, { label: "mipmap-gen" });
  const w0 = tex.size[0];
  const h0 = tex.size[1] ?? 1;
  for (let level = 1; level < levels; level++) {
    const dstW = Math.max(1, w0 >> level);
    const dstH = Math.max(1, h0 >> level);
    mip.set({
      // Single-mip views on both sides: WebGPU validates texture usage per
      // subresource, so the read level and the written level must not
      // overlap in one pass.
      src: tex.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
      dst: tex.createView({ baseMipLevel: level, mipLevelCount: 1 }),
      mipSampler: linear,
    });
    mip.dispatch(Math.ceil(dstW / 8), Math.ceil(dstH / 8));
  }
}

/** How many mip levels a texture of this size should allocate. */
export { mipLevelCount };
