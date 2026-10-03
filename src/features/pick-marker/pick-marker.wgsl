// Pick marker: a screen-space ring billboarded at the picked world point.
// The quad is generated from vertex_index (no buffers), offset in clip
// space so the ring keeps a constant pixel size at every zoom level, and
// drawn without depth testing so the marker is always visible on top of
// the terrain. The layer re-anchors `center` every frame from the grid
// coordinates plus the current vertical exaggeration, so the ring stays
// glued to the surface when the exaggeration slider moves.

struct Params {
  viewProjection: mat4x4f,
  center: vec3f,    // world position of the pick, km
  radiusPx: f32,    // ring radius in target pixels
  viewportPx: vec2f,// target size in pixels
  thicknessPx: f32, // ring stroke width in target pixels
}

@group(0) @binding(0) var<uniform> params: Params;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) localPx: vec2f, // fragment offset from center, in pixels
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var cornerX = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);
  var cornerY = array<f32, 6>(-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);
  let half = params.radiusPx + params.thicknessPx * 0.5 + 2.0;
  let localPx = vec2f(cornerX[vi], cornerY[vi]) * half;
  let clip = params.viewProjection * vec4f(params.center, 1.0);
  var out: VertexOut;
  out.localPx = localPx;
  if (clip.w <= 0.0) {
    // Anchor behind the camera: emit a clipped position, draw nothing.
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  // Convert pixel offsets to NDC: a full viewport axis spans NDC [-1, 1].
  let ndcOffset = localPx * (2.0 / params.viewportPx) * clip.w;
  out.position = vec4f(clip.xy + ndcOffset, clip.z, clip.w);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let d = length(in.localPx);
  let aa = 1.5;
  let halfT = params.thicknessPx * 0.5;
  let outlineHalf = halfT + 2.0;
  // Dark outline slightly wider than the bright ring keeps the marker
  // readable on both light and dark satellite areas.
  let outline = 1.0 - smoothstep(outlineHalf - aa, outlineHalf + aa, abs(d - params.radiusPx));
  let ring = 1.0 - smoothstep(halfT - aa, halfT + aa, abs(d - params.radiusPx));
  let rgb = mix(vec3f(0.05, 0.05, 0.08), vec3f(1.0, 0.82, 0.2), ring);
  return vec4f(rgb, max(outline, ring));
}
