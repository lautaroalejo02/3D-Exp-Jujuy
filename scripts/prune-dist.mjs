// vite build copies all of publicDir (data/build) into dist/; the debug
// overlays, headless snapshots and UI screenshots are for humans only
// and must not ship, so the build script removes them here after the copy.
import { rmSync } from "node:fs";

rmSync("dist/debug-alignment.png", { force: true });
rmSync("dist/debug-province.png", { force: true });
rmSync("dist/snapshots", { recursive: true, force: true });
rmSync("dist/ui-shots", { recursive: true, force: true });
console.log(
  "pruned dist/debug-alignment.png, dist/debug-province.png, " +
    "dist/snapshots/ and dist/ui-shots/",
);
