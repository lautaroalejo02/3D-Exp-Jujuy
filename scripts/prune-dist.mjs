// vite build copies all of publicDir (data/build) into dist/; the debug
// alignment overlay is for humans only and must not ship, so the build
// script removes it here after the copy.
import { rmSync } from "node:fs";

rmSync("dist/debug-alignment.png", { force: true });
console.log("pruned dist/debug-alignment.png");
