import type { MapCoordinate } from "./mapGeometry";

const EPSILON = 1e-8;

export interface PolygonSplitValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  unassignedAreaPercent: number;
}

export function polygonArea(polygon: readonly MapCoordinate[]): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum / 2);
}

export function validatePolygonShape(polygon: readonly MapCoordinate[]): string[] {
  const errors: string[] = [];
  if (polygon.length < 3) return ["Draw at least three boundary points."];
  if (polygon.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100)) {
    errors.push("Every point must stay inside the source map.");
  }
  if (new Set(polygon.map(({ x, y }) => `${x.toFixed(6)},${y.toFixed(6)}`)).size < 3) {
    errors.push("Use at least three distinct boundary points.");
  }
  if (polygonArea(polygon) < 0.0001) errors.push("The traced outline has no usable area.");
  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length;
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(polygon[first], polygon[firstNext], polygon[second], polygon[secondNext])) {
        errors.push("The outline crosses itself. Undo or redraw the crossing points.");
        return errors;
      }
    }
  }
  return errors;
}

export function validatePolygonSplit(
  parent: readonly MapCoordinate[],
  children: readonly (readonly MapCoordinate[])[],
): PolygonSplitValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parentErrors = validatePolygonShape(parent);
  if (parentErrors.length) errors.push("The original detection geometry is invalid; flag it for geometry review instead of splitting.");
  if (children.length < 2) errors.push("Trace at least two child outlines before previewing a split.");
  const parentArea = polygonArea(parent);
  children.forEach((child, index) => {
    const childErrors = validatePolygonShape(child);
    if (childErrors.length) errors.push(`Child ${index + 1}: ${childErrors[0]}`);
    warnings.push(...validateChildPolygon(parent, child).map((warning) => `Child ${index + 1}: ${warning}`));
  });

  for (let first = 0; first < children.length; first += 1) {
    for (let second = first + 1; second < children.length; second += 1) {
      if (polygonsOverlap(children[first], children[second])) {
        errors.push(`Polygons ${first + 1} and ${second + 1} overlap or cross. Move or redraw one outline so each printed lot has its own boundary.`);
      }
    }
  }

  const childArea = children.reduce((total, child) => total + polygonArea(child), 0);
  const unassignedAreaPercent = parentArea > EPSILON ? Math.max(0, (parentArea - childArea) / parentArea * 100) : 0;
  if (unassignedAreaPercent > 1) {
    warnings.push(`${unassignedAreaPercent.toFixed(1)}% of the original detection is not assigned to a traced child. Inspect it for a missed lot, road, or common area before confirming.`);
  }
  if (parentArea > EPSILON && childArea > parentArea * 1.01) {
    warnings.push(`Traced child area is ${((childArea / parentArea - 1) * 100).toFixed(1)}% larger than the original detection. Review this outward boundary correction against the source before confirming.`);
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings, unassignedAreaPercent };
}

export function validateChildPolygon(parent: readonly MapCoordinate[], child: readonly MapCoordinate[]): string[] {
  if (parent.length < 3 || child.length < 3) return [];
  const outside = child.some((point) => !pointInPolygon(point, parent));
  const leavesConcaveParent = child.some((point, pointIndex) => {
    const next = child[(pointIndex + 1) % child.length];
    const distance = Math.hypot(next.x - point.x, next.y - point.y);
    const steps = Math.min(500, Math.max(1, Math.ceil(distance / 0.1)));
    for (let step = 1; step < steps; step += 1) {
      const ratio = step / steps;
      if (!pointInPolygon({ x: point.x + (next.x - point.x) * ratio, y: point.y + (next.y - point.y) * ratio }, parent)) return true;
    }
    return false;
  });
  if (outside && leavesConcaveParent) return ["Child outline extends outside or crosses a concave part of the original detection. Check the highlighted raster boundary; this is allowed only as an explicit geometry correction."];
  if (outside) return ["Child outline extends outside the original detection; check the highlighted raster boundary before confirming."];
  if (leavesConcaveParent) return ["Child boundary leaves and re-enters a concave section of the original detection; inspect the raster alignment."];
  return [];
}

/** Snap only to existing map/trace vertices; never infer a boundary from raster pixels. */
export function snapMapPoint(
  point: MapCoordinate,
  candidates: readonly MapCoordinate[],
  tolerance = 0.35,
): MapCoordinate {
  let nearest: MapCoordinate | null = null;
  let nearestDistance = tolerance;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (distance <= nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest ? { ...nearest } : point;
}

/** Snap to a nearby existing polygon edge; raster pixels are never interpreted as boundaries. */
export function snapMapPointToEdges(
  point: MapCoordinate,
  polygons: readonly (readonly MapCoordinate[])[],
  tolerance = 0.35,
): MapCoordinate {
  let nearest: MapCoordinate | null = null;
  let nearestDistance = tolerance;
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared <= EPSILON) continue;
      const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
      const candidate = { x: start.x + projection * dx, y: start.y + projection * dy };
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance <= nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
  }
  return nearest ? { x: Number(nearest.x.toFixed(6)), y: Number(nearest.y.toFixed(6)) } : point;
}

function polygonsOverlap(first: readonly MapCoordinate[], second: readonly MapCoordinate[]): boolean {
  if (first.length < 3 || second.length < 3) return false;
  for (let a = 0; a < first.length; a += 1) {
    const aNext = first[(a + 1) % first.length];
    for (let b = 0; b < second.length; b += 1) {
      const bNext = second[(b + 1) % second.length];
      if (properSegmentsIntersect(first[a], aNext, second[b], bNext)) return true;
    }
  }
  const firstMidpoints = first.map((point, index) => midpoint(point, first[(index + 1) % first.length]));
  const secondMidpoints = second.map((point, index) => midpoint(point, second[(index + 1) % second.length]));
  return first.some((point) => pointStrictlyInPolygon(point, second))
    || second.some((point) => pointStrictlyInPolygon(point, first))
    || firstMidpoints.some((point) => pointStrictlyInPolygon(point, second))
    || secondMidpoints.some((point) => pointStrictlyInPolygon(point, first));
}

function midpoint(first: MapCoordinate, second: MapCoordinate): MapCoordinate {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function pointStrictlyInPolygon(point: MapCoordinate, polygon: readonly MapCoordinate[]): boolean {
  return pointInPolygon(point, polygon) && !polygon.some((current, index) => pointOnSegment(point, current, polygon[(index + 1) % polygon.length]));
}

function pointInPolygon(point: MapCoordinate, polygon: readonly MapCoordinate[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const prior = polygon[previous];
    if (pointOnSegment(point, prior, current)) return true;
    const crosses = (current.y > point.y) !== (prior.y > point.y)
      && point.x < ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegment(point: MapCoordinate, first: MapCoordinate, second: MapCoordinate): boolean {
  const cross = (point.y - first.y) * (second.x - first.x) - (point.x - first.x) * (second.y - first.y);
  if (Math.abs(cross) > EPSILON) return false;
  const dot = (point.x - first.x) * (second.x - first.x) + (point.y - first.y) * (second.y - first.y);
  if (dot < -EPSILON) return false;
  const lengthSquared = (second.x - first.x) ** 2 + (second.y - first.y) ** 2;
  return dot <= lengthSquared + EPSILON;
}

function segmentsIntersect(a: MapCoordinate, b: MapCoordinate, c: MapCoordinate, d: MapCoordinate): boolean {
  const orientation = (p: MapCoordinate, q: MapCoordinate, r: MapCoordinate) =>
    Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y));
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && pointOnSegment(c, a, b)) || (o2 === 0 && pointOnSegment(d, a, b))
    || (o3 === 0 && pointOnSegment(a, c, d)) || (o4 === 0 && pointOnSegment(b, c, d));
}

function properSegmentsIntersect(a: MapCoordinate, b: MapCoordinate, c: MapCoordinate, d: MapCoordinate): boolean {
  const cross = (p: MapCoordinate, q: MapCoordinate, r: MapCoordinate) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON));
}
