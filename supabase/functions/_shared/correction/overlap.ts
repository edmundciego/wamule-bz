/**
 * Publish overlap refusal (slice 1.5).
 *
 * A publish that would create a lot overlapping an existing parcel is
 * refused with a conflict list. Shared edges are allowed: only strict
 * interior overlap counts (vertices strictly inside the other polygon, or
 * proper edge crossings). Publish matching joins draft lots to existing
 * parcels on stable `id` — renumbers never affect linkage.
 */
import type { MapPoint, PublishConflict, PublishPlan } from "./types.ts";

export function bboxOf(poly: MapPoint[]): [number, number, number, number] {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function bboxIntersect(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** Strict point-in-polygon: boundary points count as OUTSIDE (shared edges OK). */
export function pointStrictlyInside(x: number, y: number, poly: MapPoint[]): boolean {
  // On-boundary test first (segment distance ~ 0 => outside by definition).
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) > 1e-9) continue;
    const dot = (x - a.x) * (x - b.x) + (y - a.y) * (y - b.y);
    if (dot <= 1e-9) return false;
  }
  let inside = false;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function orient(a: MapPoint, b: MapPoint, c: MapPoint): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1;
}

/** Proper crossing only (touching at endpoints/collinear overlap = shared edge, OK). */
function segmentsProperlyCross(p1: MapPoint, p2: MapPoint, p3: MapPoint, p4: MapPoint): boolean {
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return false;
  return o1 !== o2 && o3 !== o4;
}

/** True when polygons strictly overlap (shared edges alone return false). */
export function polygonsOverlap(a: MapPoint[], b: MapPoint[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  if (!bboxIntersect(bboxOf(a), bboxOf(b))) return false;
  for (const p of a) {
    if (pointStrictlyInside(p.x, p.y, b)) return true;
  }
  for (const p of b) {
    if (pointStrictlyInside(p.x, p.y, a)) return true;
  }
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsProperlyCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

export interface ExistingParcel {
  id: string;
  lot_number: string;
  polygon: MapPoint[];
}

export interface DraftLot {
  id: string;
  lot_number: string;
  polygon: MapPoint[];
  status: string;
}

/**
 * Publish plan: match drafts to existing parcels on stable id, refuse any
 * draft that would strictly overlap an existing parcel with a different id.
 */
export function matchPublish(existing: ExistingParcel[], drafts: DraftLot[]): PublishPlan {
  const byId = new Map(existing.map((p) => [p.id, p]));
  const matched: PublishPlan["matched"] = [];
  const created: string[] = [];
  const conflicts: PublishConflict[] = [];
  for (const d of drafts) {
    const prev = byId.get(d.id);
    if (prev) {
      const changes: string[] = [];
      if (prev.lot_number !== d.lot_number) changes.push(`renumber ${prev.lot_number} -> ${d.lot_number}`);
      if (JSON.stringify(prev.polygon) !== JSON.stringify(d.polygon)) changes.push("geometry");
      matched.push({ id: d.id, changes });
      continue;
    }
    const hit = existing.find((p) => polygonsOverlap(p.polygon, d.polygon));
    if (hit) {
      conflicts.push({ draftId: d.id, existingId: hit.id, kind: "overlap" });
    } else {
      created.push(d.id);
    }
  }
  return { matched, created, conflicts, ok: conflicts.length === 0 };
}
