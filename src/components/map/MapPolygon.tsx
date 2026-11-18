import type { SVGProps } from "react";
import { mapPolygonToSvgPoints, type MapCoordinate } from "../../lib/mapGeometry";

export interface MapPolygonProps extends Omit<SVGProps<SVGPolygonElement>, "points"> {
  /** Polygon vertices in source-image percentage coordinates. */
  coordinates: readonly MapCoordinate[];
  /** Per-axis map-space scaling, normally only needed for source aspect correction. */
  coordinateScale?: { x?: number; y?: number };
  coordinatePrecision?: number;
}

/** Shared SVG polygon primitive; no parcel, inventory, or review semantics. */
export function MapPolygon({
  coordinates,
  coordinateScale,
  coordinatePrecision,
  ...props
}: MapPolygonProps) {
  return (
    <polygon
      {...props}
      points={mapPolygonToSvgPoints(coordinates, coordinateScale, coordinatePrecision)}
    />
  );
}

export interface MapRasterLayerProps extends SVGProps<SVGImageElement> {
  src: string;
}

/** Shared SVG raster primitive keeps the source and normalized overlays in one coordinate space. */
export function MapRasterLayer({ src, ...props }: MapRasterLayerProps) {
  return <image {...props} href={src} pointerEvents="none" />;
}
