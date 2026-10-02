/**
 * Decoded satellite imagery handed to the terrain layer. The layer never
 * touches the DOM or the network itself: the browser decodes the JPEG with
 * `createImageBitmap` ("bitmap" variant, uploaded with
 * copyExternalImageToTexture) and the headless snapshot script decodes with
 * jpeg-js ("rgba" variant, uploaded with queue.writeTexture). Both paths
 * produce the same rgba8unorm texels.
 */
export type SatelliteImage =
  | {
      readonly kind: "bitmap";
      readonly bitmap: ImageBitmap;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "rgba";
      readonly pixels: Uint8Array;
      readonly width: number;
      readonly height: number;
    };
