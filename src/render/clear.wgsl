// Minimal scaffold shader: fills the canvas with a neutral color until the
// terrain layer lands.
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(0.10, 0.12, 0.16, 1.0);
}
