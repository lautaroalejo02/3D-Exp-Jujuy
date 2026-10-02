// Mipmap generation: vgpu has no mip-generation helper, so each mip level
// is filled by one compute dispatch that bilinearly downsamples the
// previous level. `src` and `dst` are single-mip views of the same texture
// (previous level / level being written) — see render/mipmap.ts.
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var mipSampler: sampler;

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(dst);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let uv = (vec2f(id.xy) + vec2f(0.5)) / vec2f(dims);
  textureStore(dst, vec2i(id.xy), textureSampleLevel(src, mipSampler, uv, 0.0));
}
