// Validates every src/**/*.wgsl shader with `vgpu check`.
// (Was an inline node -e one-liner in package.json; moved here verbatim.)
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".wgsl")) files.push(p);
  }
};
walk("src");
if (files.length === 0) console.log("check:wgsl: no .wgsl files under src/");
for (const f of files) {
  console.log("vgpu check " + f);
  execFileSync(process.execPath, ["node_modules/vgpu/bin/vgpu.js", "check", f], {
    stdio: "inherit",
  });
}
