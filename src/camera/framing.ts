import { elevationToWorldY, metersPerGridCell, type GridSpec } from "../geo";
import { OrbitCamera } from "./camera";

/**
 * Initial view: the whole grid visible from the south-east, looking
 * north-west, tilted ~45°. The distance is derived from the grid's real
 * ground extent (never a hand-picked number): the footprint projected onto
 * the view-right axis must fit the horizontal FOV, and the view-depth
 * extent (foreshortened by the elevation) plus the relief must fit the
 * vertical FOV.
 */
export function overviewCamera(
  spec: GridSpec,
  aspect: number,
  relief: {
    /** Highest elevation of the loaded heightfield (from the DEM), meters. */
    readonly maxElevationMeters: number;
    readonly verticalExaggeration: number;
  },
  options: {
    readonly fovDeg?: number;
    readonly margin?: number;
  } = {},
): OrbitCamera {
  const fovDeg = options.fovDeg ?? 45;
  const margin = options.margin ?? 1.1;
  // Vertical allowance for the exaggerated relief, in world km.
  const reliefKm = elevationToWorldY(relief.maxElevationMeters, relief.verticalExaggeration);
  const azimuthDeg = 45; // camera south-east of the grid center
  const elevationDeg = 45;
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;

  const cellKm = metersPerGridCell(spec) / 1000;
  const halfX = (spec.width * cellKm) / 2;
  const halfZ = (spec.height * cellKm) / 2;
  // Extent across the view (perpendicular to the view direction) and along
  // the view direction, both measured on the ground plane.
  const halfAcross = halfX * Math.abs(Math.cos(az)) + halfZ * Math.abs(Math.sin(az));
  const halfAlong = halfX * Math.abs(Math.sin(az)) + halfZ * Math.abs(Math.cos(az));

  const halfFovY = (fovDeg * Math.PI) / 360;
  const halfFovX = Math.atan(Math.tan(halfFovY) * aspect);
  const distForWidth = halfAcross / Math.tan(halfFovX);
  const distForHeight =
    (halfAlong * Math.sin(el) + reliefKm * Math.cos(el)) / Math.tan(halfFovY);
  const distanceKm = Math.max(distForWidth, distForHeight) * margin;

  return new OrbitCamera({
    target: [0, 0, 0],
    distanceKm,
    azimuthDeg,
    elevationDeg,
    fovDeg,
    aspect,
    nearKm: 0.5,
    minDistanceKm: 10,
    maxDistanceKm: Math.max(1500, distanceKm * 1.5),
  });
}
