// Present pass: composites the offscreen scene target onto the canvas (or
// an output target in headless rendering). See two-pass-rendering.
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(scene, sceneSampler, uv, 0.0);
}
