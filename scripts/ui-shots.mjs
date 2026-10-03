// UI screenshot harness: serves the built dist/ with `vite preview`,
// drives headless Chromium (WebGPU via SwiftShader when available) and
// captures the mobile/desktop layouts into data/build/ui-shots/.
//
// If WebGPU cannot initialize headlessly the app shows its fallback
// notice — the mode bar and sheets still mount, so the shots remain
// useful; the script reports which state it captured.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "data", "build", "ui-shots");

/** Finds a free TCP port so the harness survives parallel worktrees. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Flags that give headless Chromium a software WebGPU adapter on most
// platforms (SwiftShader through Dawn). Harmless where they are ignored
// — the app's fallback notice still leaves the UI on screen.
const WEBGPU_ARGS = [
  "--enable-unsafe-webgpu",
  "--use-webgpu-adapter=swiftshader",
];

// Launch candidates, most reproducible first: the bundled Chromium,
// then installed channels (their headless builds expose a WebGPU
// adapter on Windows where the bundled one may not).
const BROWSER_CANDIDATES = [
  { name: "chromium" },
  { name: "chrome", channel: "chrome" },
  { name: "msedge", channel: "msedge" },
];

/**
 * Launches the first candidate whose page gets a WebGPU adapter on the
 * app URL; if none does, returns the bundled-Chromium browser anyway so
 * the shots still capture the fallback UI. Returns { browser, note }.
 */
async function launchBrowser(base) {
  let fallback;
  const launchErrors = [];
  for (const candidate of BROWSER_CANDIDATES) {
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: WEBGPU_ARGS,
        ...(candidate.channel ? { channel: candidate.channel } : {}),
      });
    } catch (error) {
      // Usually the channel is not installed; keep the cause in case none launch.
      launchErrors.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const page = await browser.newPage();
    let ok = false;
    try {
      await page.goto(base, { waitUntil: "domcontentloaded" });
      ok = await page.evaluate(
        async () => !!(await navigator.gpu?.requestAdapter()),
      );
    } catch (error) {
      console.warn(
        `browser ${candidate.name}: WebGPU probe failed (${error instanceof Error ? error.message : String(error)})`,
      );
      ok = false;
    }
    await page.close();
    if (ok) {
      console.log(`browser: ${candidate.name} (WebGPU adapter available)`);
      return { browser, note: candidate.name };
    }
    fallback ??= browser;
    if (fallback !== browser) await browser.close();
  }
  if (!fallback) {
    throw new Error(
      `no browser could be launched (run \`npx playwright install chromium\`):\n  ${launchErrors.join("\n  ")}`,
    );
  }
  console.log("browser: chromium (no WebGPU adapter — fallback UI)");
  return { browser: fallback, note: "chromium-fallback" };
}

/** Waits until vite preview answers HTTP requests. */
async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`vite preview did not start on ${url}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Loads the app and waits until either the Explorar place list has
 * rendered (data path complete) or the fallback notice is up.
 */
async function openApp(context, base) {
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mode-bar");
  // Both probes are created dynamically only when the data path ran /
  // the fallback notice mounted, so "attached" is a safe readiness signal
  // that does not depend on sheet-snap CSS hiding content.
  const appReady = page
    .waitForSelector(".explorar-places-item", {
      timeout: 60000,
      state: "attached",
    })
    .then(() => "rendered");
  const fallback = page
    .waitForSelector(".webgpu-notice", { timeout: 60000, state: "attached" })
    .then(() => "webgpu-fallback");
  const state = await Promise.race([appReady, fallback]).catch(() => "timeout");
  return { page, state };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // Spawn vite through node directly (no shell wrapper) so kill()
  // terminates the preview server on every platform.
  const viteBin = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const server = spawn(
    process.execPath,
    [
      viteBin,
      "preview",
      "--port",
      String(port),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
    { cwd: ROOT, stdio: "ignore" },
  );
  try {
    await waitForServer(base);

    const { browser } = await launchBrowser(base);
    try {
      // ---- Mobile: 390x844, touch device, designed-first layout ----
      const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      });

      {
        const { page, state } = await openApp(mobile, base);
        console.log(`mobile: app state = ${state}`);

        // Let a few frames render so marker clustering/occlusion settle.
        await sleep(500);
        await page.screenshot({
          path: join(OUT_DIR, "mobile-overview-clusters.png"),
        });
        await page.screenshot({
          path: join(OUT_DIR, "mobile-explorar-min.png"),
        });

        // Tap the sheet head: minimized -> half snap.
        await page.locator("#sheet-mode .sheet-head").tap();
        await page.waitForSelector('#sheet-mode[data-snap="half"]');
        await sleep(450);
        await page.screenshot({
          path: join(OUT_DIR, "mobile-explorar-half.png"),
        });

        // Drag the sheet head up: half -> full snap (pointer capture on
        // the head makes real mouse moves drive the sheet drag).
        const headBox = await page
          .locator("#sheet-mode .sheet-head")
          .boundingBox();
        if (!headBox) throw new Error("sheet head not measurable");
        const cx = headBox.x + headBox.width / 2;
        const cy = headBox.y + headBox.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx, Math.max(10, cy - 620), { steps: 12 });
        await page.mouse.up();
        await page.waitForSelector('#sheet-mode[data-snap="full"]');
        await sleep(450);
        await page.screenshot({
          path: join(OUT_DIR, "mobile-explorar-full.png"),
        });

        // Drag back down to half — the realistic state a place is
        // opened from (the user browses the list at the half snap).
        const halfHeadBox = await page
          .locator("#sheet-mode .sheet-head")
          .boundingBox();
        if (!halfHeadBox) throw new Error("sheet head not measurable");
        const hx = halfHeadBox.x + halfHeadBox.width / 2;
        const hy = halfHeadBox.y + halfHeadBox.height / 2;
        await page.mouse.move(hx, hy);
        await page.mouse.down();
        await page.mouse.move(hx, hy + 300, { steps: 12 });
        await page.mouse.up();
        await page.waitForSelector('#sheet-mode[data-snap="half"]');
        await sleep(450);

        // Tap the first place: camera flies, the card opens at half and
        // the Explorar sheet folds to its title row underneath it.
        await page.locator(".explorar-places-item").first().tap();
        await page.waitForSelector("#sheet-detail[data-sheet-open]");
        await page.waitForSelector('#sheet-mode[data-snap="min"]');
        await sleep(1700); // let the camera flight settle
        await page.screenshot({
          path: join(OUT_DIR, "mobile-place-card.png"),
        });

        // "Ver más" expands the card's extract, facts and links.
        await page.locator(".place-card-more").tap();
        await page.waitForSelector('.place-card-more[aria-expanded="true"]');
        await sleep(350);
        await page.screenshot({
          path: join(OUT_DIR, "mobile-place-card-expanded.png"),
        });
        await page.close();
      }

      {
        const { page } = await openApp(mobile, base);
        await page.locator('[data-mode="sol"]').tap();
        await page.waitForSelector("#sheet-sol .mode-placeholder");
        await sleep(450);
        await page.screenshot({
          path: join(OUT_DIR, "mobile-sol.png"),
        });
        await page.close();
      }
      await mobile.close();

      // ---- Desktop: 1440x900, left side panel ----
      const desktop = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      });
      {
        const { page, state } = await openApp(desktop, base);
        console.log(`desktop: app state = ${state}`);

        await page.screenshot({
          path: join(OUT_DIR, "desktop-explorar.png"),
        });

        await page.locator(".explorar-places-item").first().click();
        await page.waitForSelector("#sheet-detail[data-sheet-open]");
        await sleep(1700);
        await page.screenshot({
          path: join(OUT_DIR, "desktop-place-card.png"),
        });
        await page.close();
      }
      await desktop.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }

  console.log(`ui shots written to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
