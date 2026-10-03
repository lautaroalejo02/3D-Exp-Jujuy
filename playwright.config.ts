// Playwright configuration for the UI screenshot harness. The actual
// capture script (scripts/ui-shots.mjs) launches Chromium itself so the
// same flags/contexts can run without the test runner; this file keeps
// the shared settings in one place for future `playwright test` specs.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  use: {
    baseURL: "http://127.0.0.1:4173",
    launchOptions: {
      // Software WebGPU (SwiftShader) so the app can render headlessly;
      // harmless where the adapter is unavailable — the app's fallback
      // notice still leaves the UI on screen.
      args: [
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-angle=swiftshader",
        "--use-webgpu-adapter=swiftshader",
      ],
    },
  },
});
