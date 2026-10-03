/**
 * Verifies the detail-patch raw tiles (data/raw/detail/<site>/) against
 * their recorded sources:
 *
 * 1. every tile declared in data/raw/detail/sources.json is fetched again
 *    from its recorded `url` and its sha256 compared with the recorded
 *    hash (the file is never written — data/raw/ is read-only, AGENTS.md);
 * 2. the copy on disk is also hashed and compared, so local corruption is
 *    reported in the same run.
 *
 * Prints one line per check that failed plus a summary, and exits
 * non-zero on any mismatch, missing file or failed download.
 *
 * Run: `npm run verify:detail`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCES_PATH = join(ROOT, "data/raw/detail/sources.json");

interface SourcesTile {
  readonly file: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface SourcesDoc {
  readonly description: string;
  readonly sites: readonly unknown[];
  readonly tiles: readonly SourcesTile[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(): Promise<void> {
  const sources = JSON.parse(
    readFileSync(SOURCES_PATH, "utf8"),
  ) as SourcesDoc;
  const failures: string[] = [];
  let checked = 0;

  for (const tile of sources.tiles) {
    checked++;
    // Local copy vs recorded hash.
    const path = join(ROOT, tile.file);
    if (!existsSync(path)) {
      failures.push(`${tile.file}: missing on disk`);
    } else {
      const local = readFileSync(path);
      const localSha = sha256(local);
      if (local.length !== tile.bytes) {
        failures.push(
          `${tile.file}: ${local.length} B on disk, sources.json ` +
            `recorded ${tile.bytes} B`,
        );
      }
      if (localSha !== tile.sha256) {
        failures.push(
          `${tile.file}: sha256 on disk ${localSha} != recorded ` +
            `${tile.sha256}`,
        );
      }
    }

    // Recorded hash vs a fresh download (memory only, nothing is written).
    try {
      const res = await fetch(tile.url);
      if (!res.ok) {
        failures.push(`${tile.file}: HTTP ${res.status} from ${tile.url}`);
      } else {
        const remote = new Uint8Array(await res.arrayBuffer());
        const remoteSha = sha256(remote);
        if (remoteSha !== tile.sha256) {
          failures.push(
            `${tile.file}: downloaded sha256 ${remoteSha} != recorded ` +
              `${tile.sha256} (${tile.url})`,
          );
        }
      }
    } catch (error) {
      failures.push(
        `${tile.file}: download failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    if (checked % 30 === 0 || checked === sources.tiles.length) {
      console.log(`checked ${checked}/${sources.tiles.length} tiles`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `FAIL: ${failures.length} problem(s) in data/raw/detail sources:`,
    );
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `OK: all ${sources.tiles.length} tiles match sources.json ` +
      `(sha256 verified on disk and against a fresh download)`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
