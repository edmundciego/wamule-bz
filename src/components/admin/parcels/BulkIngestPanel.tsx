import { useMemo, useState } from "react";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Field, Input } from "../../ui/Field";
import { ErrorState } from "../../ui/State";

export interface IngestLot {
  lot_number: string;
  tier_key: string;
  price: number;
  polygon_pct: Array<{ x: number; y: number }>;
  confidence: number;
  needs_review: boolean;
  source: string;
}

interface BoardRow {
  lot_number: string;
  base_price: number | null;
  map_polygon: unknown;
}

interface BulkIngestPanelProps {
  boardRows: BoardRow[];
}

interface IngestStats {
  lots: IngestLot[];
  perTier: Record<string, number>;
  needsReview: number;
  badGeometry: number;
}

function analyze(raw: unknown): IngestStats {
  if (!Array.isArray(raw)) throw new Error("lots.json must contain an array of lots.");
  const perTier: Record<string, number> = {};
  let needsReview = 0;
  let badGeometry = 0;
  const lots = raw as IngestLot[];
  for (const lot of lots) {
    perTier[String(lot.tier_key ?? "unknown")] = (perTier[String(lot.tier_key ?? "unknown")] ?? 0) + 1;
    if (lot.needs_review) needsReview++;
    const pts = lot.polygon_pct;
    const ok =
      Array.isArray(pts) &&
      pts.length >= 3 &&
      pts.length <= 200 &&
      pts.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100);
    if (!ok) badGeometry++;
    if (typeof lot.lot_number !== "string" || !lot.lot_number) throw new Error("Every lot needs a lot_number string.");
    if (typeof lot.price !== "number" || !(lot.price > 0)) throw new Error(`Lot ${lot.lot_number}: price must be positive.`);
  }
  const seen = new Set(lots.map((lot) => lot.lot_number));
  if (seen.size !== lots.length) throw new Error("Duplicate lot_number values in lots.json.");
  return { lots, perTier, needsReview, badGeometry };
}

export function BulkIngestPanel({ boardRows }: BulkIngestPanelProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [stats, setStats] = useState<IngestStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const diff = useMemo(() => {
    if (!stats) return null;
    const boardByLot = new Map(boardRows.map((row) => [row.lot_number, row]));
    const fileSet = new Set(stats.lots.map((lot) => lot.lot_number));
    let create = 0;
    let update = 0;
    let unchanged = 0;
    for (const lot of stats.lots) {
      const existing = boardByLot.get(lot.lot_number);
      if (!existing) {
        create++;
        continue;
      }
      const priceChanged = Number(existing.base_price ?? 0) !== Number(lot.price);
      const polyChanged = JSON.stringify(existing.map_polygon ?? []) !== JSON.stringify(lot.polygon_pct);
      if (priceChanged || polyChanged) update++;
      else unchanged++;
    }
    const stale = boardRows.filter((row) => !fileSet.has(row.lot_number)).length;
    return { create, update, unchanged, stale };
  }, [stats, boardRows]);

  async function handleFile(file: File | undefined) {
    setError(null);
    setStats(null);
    setFileName(null);
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      setStats(analyze(parsed));
      setFileName(file.name);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Could not read lots.json.");
    }
  }

  return (
    <div className="grid gap-4">
      <div className="v2-workflow-panel p-4 text-sm text-primary">
        Preview-only: this panel validates a <code>map:build</code> <code>lots.json</code> file and diffs it against the
        live board. Nothing is written from here — applying stays in the audited CLI (
        <code>npm run map:publish -- --tenant &lt;slug&gt; --dir &lt;out&gt; --apply</code>), which inserts new lots
        as Available, updates price + geometry only, and never deletes or flips statuses.
      </div>
      {error ? <ErrorState message={error} /> : null}
      <Field label="lots.json from map:build">
        <Input
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </Field>
      {stats && diff ? (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="v2-record-row">
              <p className="text-sm font-semibold text-primary">File lots</p>
              <Badge tone="blue">{stats.lots.length}</Badge>
            </div>
            <div className="v2-record-row">
              <p className="text-sm font-semibold text-primary">Needs review</p>
              <Badge tone={stats.needsReview ? "red" : "green"}>{stats.needsReview}</Badge>
            </div>
            <div className="v2-record-row">
              <p className="text-sm font-semibold text-primary">Invalid geometry</p>
              <Badge tone={stats.badGeometry ? "red" : "green"}>{stats.badGeometry}</Badge>
            </div>
            <div className="v2-record-row">
              <p className="text-sm font-semibold text-primary">Source</p>
              <Badge tone="gray">{fileName}</Badge>
            </div>
          </div>
          <div className="v2-workflow-panel p-4">
            <p className="text-sm font-semibold text-primary">Per-tier breakdown</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(stats.perTier).map(([tier, count]) => (
                <Badge key={tier} tone="gray">
                  {tier}: {count}
                </Badge>
              ))}
            </div>
          </div>
          <div className="v2-workflow-panel p-4">
            <p className="text-sm font-semibold text-primary">Board diff (preview)</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Badge tone="green">{diff.create} create</Badge>
              <Badge tone="amber">{diff.update} update</Badge>
              <Badge tone="gray">{diff.unchanged} unchanged</Badge>
              <Badge tone="slate">{diff.stale} stale (kept)</Badge>
            </div>
            {stats.badGeometry ? (
              <p className="mt-2 text-sm text-danger">
                {stats.badGeometry} lots have invalid geometry — fix the build before publishing.
              </p>
            ) : null}
          </div>
          <div>
            <Button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(
                  `npm run map:publish -- --tenant <slug> --dir <out-dir> --dry-run`,
                );
              }}
            >
              Copy dry-run command
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
