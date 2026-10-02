/**
 * GPU memory accounting. Every GPU resource created by the app registers
 * its byte size here; the report is computed from allocation parameters
 * (formats and mip counts), not queried back from the driver.
 */

export interface GpuMemoryEntry {
  readonly label: string;
  readonly bytes: number;
  /** True when the figure is an estimate rather than an exact allocation. */
  readonly estimate?: boolean;
}

export interface GpuMemoryReport {
  readonly entries: readonly GpuMemoryEntry[];
  readonly totalBytes: number;
}

/** Mip count for a full mip chain (level 0 down to 1x1). */
export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/** Total texels of a full mip chain starting at width x height. */
export function mipChainTexelCount(width: number, height: number): number {
  let texels = 0;
  let w = width;
  let h = height;
  for (let level = 0; level < mipLevelCount(width, height); level++) {
    texels += w * h;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return texels;
}

/** Bytes for a 4-bytes-per-texel texture including its whole mip chain. */
export function textureBytesWithMips(
  width: number,
  height: number,
  bytesPerTexel = 4,
): number {
  return mipChainTexelCount(width, height) * bytesPerTexel;
}

export function buildGpuMemoryReport(
  entries: readonly GpuMemoryEntry[],
): GpuMemoryReport {
  return {
    entries,
    totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
