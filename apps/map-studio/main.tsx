import { createRoot } from "react-dom/client";
import { useRef, useState, type ChangeEvent } from "react";
import { MapPackagePreview } from "../../src/components/maps/MapPackagePreview";
import {
  validateMapPackage,
  verifyMapPackageAsset,
  mergePlotCsv,
  MAP_PACKAGE_MAX_BYTES,
  type MapPackage,
  type PackageCategory,
  type PackagePlot,
} from "../../src/lib/mapPackage.mjs";
import "./studio.css";

function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Studio() {
  const [map, setMap] = useState<MapPackage | null>(null);
  const [source, setSource] = useState<File | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [categories, setCategories] = useState<PackageCategory[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [layers, setLayers] = useState<string[]>([]);
  const [boundaryLayer, setBoundaryLayer] = useState("");
  const [units, setUnits] = useState("");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  const [asRevision, setAsRevision] = useState(false);
  const [editingBoundary, setEditingBoundary] = useState(false);
  const [snap, setSnap] = useState(false);
  const requestId = useRef(0);
  const current = map?.plots.find((p) => p.key === selected);
  const visible =
    map?.plots.filter(
      (p) =>
        (!onlyUnreviewed || !p.reviewed) &&
        `${p.number ?? ""} ${p.key} ${p.source_layer ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) ?? [];

  async function extract(file = source) {
    if (!file) return;
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (file.size > MAP_PACKAGE_MAX_BYTES)
        throw new Error("Choose a source under 24 MB.");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read the source."));
        reader.readAsDataURL(file);
      });
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          data_base64: data,
          options: {
            boundary_layer: boundaryLayer || undefined,
            units: units || undefined,
            page: page - 1,
            categories,
          },
        }),
      });
      const result = await response.json();
      if (!response.ok || result.error)
        throw new Error(result.error || "Extraction failed.");
      let pkg = validateMapPackage(result.package);
      if (id !== requestId.current) return;
      // Re-extracting the same source retains the dataset identity. Opening a
      // previous package before a revised CAD file does the same deliberately.
      if (map && (file === source || asRevision))
        pkg = {
          ...pkg,
          dataset_id: map.dataset_id,
          revision: map.revision + 1,
        };
      setMap(pkg);
      setSelected(pkg.plots[0]?.key ?? null);
      setCategories(pkg.categories);
      setLayers(Object.keys(result.layers ?? {}));
      setNotes(result.notes ?? []);
      setMessage(
        `${pkg.plots.length} outlines extracted. Review the boundaries and plot data before export.`,
      );
    } catch (err) {
      if (id === requestId.current)
        setError(err instanceof Error ? err.message : "Extraction failed.");
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }
  async function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setMessage(null);
    if (/\.json$/i.test(file.name)) {
      requestId.current++;
      setBusy(false);
      try {
        if (file.size > MAP_PACKAGE_MAX_BYTES)
          throw new Error("Package exceeds 24 MB.");
        const pkg = validateMapPackage(JSON.parse(await file.text()));
        await verifyMapPackageAsset(pkg);
        setMap(pkg);
        setCategories(pkg.categories);
        setSelected(pkg.plots[0].key);
        setSource(null);
        setNotes([]);
        setLayers([]);
        setMessage(
          "Package opened. Its dataset identity will be retained for future exports.",
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not open the package.",
        );
      }
    } else {
      setSource(file);
      await extract(file);
    }
  }
  function editPlot(update: Partial<PackagePlot>) {
    setMap((old) =>
      old
        ? {
            ...old,
            plots: old.plots.map((p) =>
              p.key === selected ? { ...p, ...update } : p,
            ),
          }
        : old,
    );
  }
  function updateCategories(next: PackageCategory[]) {
    setCategories(next);
    setMap((old) => (old ? { ...old, categories: next } : old));
  }
  function renameCategory(index: number, key: string) {
    if (!/^[a-z0-9_]{0,80}$/.test(key)) return;
    if (categories.some((c, i) => i !== index && c.key === key)) {
      setError("That category code is already in use. Choose a unique code.");
      return;
    }
    const previous = categories[index].key;
    const next = categories.map((c, i) => (i === index ? { ...c, key } : c));
    setCategories(next);
    setMap((old) =>
      old
        ? {
            ...old,
            categories: next,
            plots: old.plots.map((p) =>
              p.category_key === previous ? { ...p, category_key: key } : p,
            ),
          }
        : old,
    );
    setError(null);
  }
  function addCategory() {
    let index = categories.length + 1;
    while (categories.some((c) => c.key === `category_${index}`)) index++;
    const key = `category_${index}`;
    updateCategories([
      ...categories,
      {
        key,
        label: `Category ${categories.length + 1}`,
        color: "#86b69b",
        price_cents: null,
        currency: null,
        price_basis: null,
      },
    ]);
  }
  async function csv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!map || !file) return;
    try {
      setMap(mergePlotCsv(map, await file.text()));
      setError(null);
      setMessage("Spreadsheet rows matched and applied in this draft.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV import failed.");
    }
  }
  function save() {
    if (!map) return;
    try {
      const pkg = validateMapPackage(map);
      download(
        `${pkg.title.replace(/[^a-z0-9-]/gi, "-")}.wamule-map.json`,
        JSON.stringify(pkg, null, 2),
      );
      setMessage(
        "Package exported. Open Admin → Maps → Import package to choose its destination.",
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  }
  return (
    <div className="studio">
      <header className="studio-header">
        <a className="studio-brand" href="/">
          W<span>Map Studio</span>
        </a>
        <span className="local-tag">Local preparation tool</span>
        <span className="header-note">
          Source → Review → Plot data → Export
        </span>
      </header>
      <main>
        <div className="studio-intro">
          <div>
            <p className="eyebrow">FROM DRAWING TO INTERACTIVE MAP</p>
            <h1>A clear plan for every plot.</h1>
            <p>
              Prepare your map here. Choose its tenant and project later in
              Admin.
            </p>
          </div>
          <label className="studio-button">
            Open source or package
            <input
              type="file"
              accept=".dxf,.dwg,.pdf,.png,.jpg,.jpeg,.webp,.json"
              onChange={(e) => void load(e)}
              disabled={busy}
            />
          </label>
        </div>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {message && (
          <div className="alert success" role="status">
            {message}
          </div>
        )}
        {map && (
          <label className="check-label" style={{ marginBottom: 16 }}>
            <input
              type="checkbox"
              checked={asRevision}
              onChange={(e) => setAsRevision(e.target.checked)}
            />{" "}
            Use the next source as a revision of this map, retaining its dataset
            identity. Leave clear to start a separate map.
          </label>
        )}
        <section className="studio-card source-card">
          <div>
            <h2>1. Source & extraction</h2>
            <p>
              {source?.name ??
                map?.source.name ??
                "DXF · PDF · PNG · JPEG · WebP"}
            </p>
            <small>
              DWG drawings need a DXF export. Your source stays on this
              computer.
            </small>
          </div>
          <div className="source-options">
            <label>
              Drawing units
              <select value={units} onChange={(e) => setUnits(e.target.value)}>
                <option value="">Read from file</option>
                <option value="m">Metres</option>
                <option value="ft">Feet</option>
                <option value="us-ft">US survey feet</option>
                <option value="unknown">Unspecified</option>
              </select>
            </label>
            <label>
              Boundary layer
              <input
                list="boundary-layers"
                value={boundaryLayer}
                onChange={(e) => setBoundaryLayer(e.target.value)}
                placeholder="All closed boundaries"
              />
              <datalist id="boundary-layers">
                {layers.map((layer) => (
                  <option key={layer} value={layer} />
                ))}
              </datalist>
            </label>
            <label>
              PDF page
              <input
                type="number"
                min="1"
                value={page}
                onChange={(e) => setPage(Math.max(1, Number(e.target.value)))}
              />
            </label>
            <button disabled={!source || busy} onClick={() => void extract()}>
              {busy ? "Extracting…" : "Extract again"}
            </button>
          </div>
        </section>
        {notes.length > 0 && (
          <div className="studio-notes">
            {notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        )}
        {!map && (
          <section className="studio-empty">
            <div className="drawing-icon">◇</div>
            <h2>Start with the original drawing</h2>
            <p>
              CAD boundaries and labels are read directly. For colored raster
              plans, add the category colors below before extracting.
            </p>
            <div className="empty-steps">
              <span>01 &nbsp;Open a source</span>
              <span>02 &nbsp;Review its outlines</span>
              <span>03 &nbsp;Export your package</span>
            </div>
          </section>
        )}
        {map && (
          <>
            <div className="map-summary">
              <label>
                Map title
                <input
                  value={map.title}
                  onChange={(e) => setMap({ ...map, title: e.target.value })}
                />
              </label>
              <span>
                <strong>{map.plots.length}</strong> outlines
              </span>
              <span>
                <strong>{map.plots.filter((p) => p.reviewed).length}</strong>{" "}
                reviewed
              </span>
              <span>
                <strong>{map.plots.filter((p) => p.number).length}</strong>{" "}
                numbered
              </span>
              <span>Revision {map.revision}</span>
            </div>
            <section className="studio-workbench" aria-label="Boundary review">
              <div className="studio-card map-card">
                <h2>2. Review the map</h2>
                <MapPackagePreview
                  key={map.source.sha256 + map.revision}
                  map={map}
                  selectedKey={selected}
                  onSelect={setSelected}
                  editMode={editingBoundary}
                  snap={snap}
                  onPolygonChange={(polygon) =>
                    editPlot({ polygon, reviewed: false })
                  }
                />
                <button
                  className="secondary"
                  onClick={() =>
                    setMap({
                      ...map,
                      plots: map.plots.map((p) => ({ ...p, reviewed: true })),
                    })
                  }
                >
                  Mark all displayed boundaries reviewed
                </button>
              </div>
              <aside className="studio-card inspector">
                <h2>Plot inspector</h2>
                <input
                  placeholder="Find number or source reference"
                  aria-label="Find plot"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={onlyUnreviewed}
                    onChange={(e) => setOnlyUnreviewed(e.target.checked)}
                  />{" "}
                  Unreviewed only
                </label>
                <select
                  aria-label="Select plot"
                  size={5}
                  value={selected ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {visible.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.number || p.key} {p.reviewed ? "✓" : ""}
                    </option>
                  ))}
                </select>
                {current && (
                  <div className="inspector-fields">
                    <small>
                      {current.key} · {current.source_layer}
                    </small>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={editingBoundary}
                        onChange={(e) => setEditingBoundary(e.target.checked)}
                      />{" "}
                      Edit boundary vertices
                    </label>
                    {editingBoundary && (
                      <>
                        <label className="check-label">
                          <input
                            type="checkbox"
                            checked={snap}
                            onChange={(e) => setSnap(e.target.checked)}
                          />{" "}
                          Snap display vertices to grid
                        </label>
                        <p className="review-note">
                          Drag the blue vertices. Display edits preserve the
                          recorded area and original boundary.
                        </p>
                        <details>
                          <summary>Vertex coordinates (%)</summary>
                          {current.polygon.map((point, index) => (
                            <div className="field-pair" key={index}>
                              {(["x", "y"] as const).map((axis) => (
                                <label key={axis}>
                                  {index + 1} · {axis}
                                  <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    step="0.01"
                                    value={point[axis]}
                                    onChange={(e) =>
                                      editPlot({
                                        polygon: current.polygon.map((p, i) =>
                                          i === index
                                            ? {
                                                ...p,
                                                [axis]: Math.max(
                                                  0,
                                                  Math.min(
                                                    100,
                                                    Number(e.target.value),
                                                  ),
                                                ),
                                              }
                                            : p,
                                        ),
                                        reviewed: false,
                                      })
                                    }
                                  />
                                </label>
                              ))}
                            </div>
                          ))}
                        </details>
                        <button
                          className="secondary"
                          onClick={() =>
                            editPlot({
                              polygon: current.original_polygon.map((p) => ({
                                ...p,
                              })),
                              reviewed: false,
                            })
                          }
                        >
                          Restore original boundary
                        </button>
                      </>
                    )}
                    <label>
                      Outline type
                      <select
                        value={current.kind}
                        onChange={(e) =>
                          editPlot({
                            kind: e.target.value as PackagePlot["kind"],
                          })
                        }
                      >
                        <option value="plot">Plot</option>
                        <option value="common_area">Common area</option>
                        <option value="amenity">Amenity</option>
                      </select>
                    </label>
                    <label>
                      Plot number
                      <input
                        value={current.number ?? ""}
                        placeholder="Leave blank if unmatched"
                        onChange={(e) =>
                          editPlot({ number: e.target.value || null })
                        }
                      />
                    </label>
                    <label>
                      Category
                      <select
                        value={current.category_key ?? ""}
                        onChange={(e) =>
                          editPlot({ category_key: e.target.value || null })
                        }
                      >
                        <option value="">Unassigned</option>
                        {categories.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="field-pair">
                      <label>
                        Area
                        <input
                          type="number"
                          min="0"
                          value={current.area_value ?? ""}
                          onChange={(e) =>
                            editPlot({
                              area_value: e.target.value
                                ? Number(e.target.value)
                                : null,
                              area_unit: e.target.value
                                ? (current.area_unit ?? "m2")
                                : null,
                              area_basis: "recorded",
                            })
                          }
                        />
                      </label>
                      <label>
                        Unit
                        <select
                          value={current.area_unit ?? ""}
                          disabled={current.area_value === null}
                          onChange={(e) =>
                            editPlot({
                              area_unit: e.target
                                .value as PackagePlot["area_unit"],
                            })
                          }
                        >
                          <option value="">Choose</option>
                          <option value="m2">m²</option>
                          <option value="ft2">ft²</option>
                          <option value="acres">Acres</option>
                        </select>
                      </label>
                    </div>
                    <small>
                      {current.area_basis === "cad-calculated"
                        ? "Area calculated from CAD coordinates and declared units."
                        : "Enter the recorded area; the display shape does not set it."}
                    </small>
                    <label>
                      Dimensions (optional)
                      <input
                        value={current.dimensions ?? ""}
                        onChange={(e) =>
                          editPlot({ dimensions: e.target.value || null })
                        }
                      />
                    </label>
                    <label>
                      Plot price override
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={
                          current.price_cents === null
                            ? ""
                            : current.price_cents / 100
                        }
                        placeholder="Use category price"
                        onChange={(e) =>
                          editPlot({
                            price_cents: e.target.value
                              ? Math.round(Number(e.target.value) * 100)
                              : null,
                          })
                        }
                      />
                    </label>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={current.reviewed}
                        onChange={(e) =>
                          editPlot({ reviewed: e.target.checked })
                        }
                      />{" "}
                      Boundary reviewed
                    </label>
                    {current.issues.map((issue) => (
                      <p className="review-note" key={issue}>
                        {issue}
                      </p>
                    ))}
                  </div>
                )}
              </aside>
            </section>
          </>
        )}
        <section className="studio-card">
          <div className="section-title">
            <div>
              <h2>3. Categories & plot data</h2>
              <p>
                Prices are optional. Set a currency explicitly when known.
                Category codes match the project catalogue during import.
              </p>
            </div>
            <button className="secondary" onClick={addCategory}>
              Add category
            </button>
          </div>
          <div className="category-list">
            {categories.map((c, i) => (
              <div className="category-entry" key={i}>
                <label className="category-code">
                  Category code
                  <input
                    value={c.key}
                    maxLength={80}
                    onChange={(e) => renameCategory(i, e.target.value)}
                    placeholder="standard_interior"
                  />
                </label>
                <div className="category-row">
                  <label className="swatch-label">
                    Color
                    <input
                      type="color"
                      aria-label={`Color for ${c.label}`}
                      value={c.color}
                      onChange={(e) =>
                        updateCategories(
                          categories.map((item, index) =>
                            index === i
                              ? { ...item, color: e.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  {(
                    ["label", "price_cents", "currency", "price_basis"] as const
                  ).map((field) => (
                    <label key={field}>
                      {field === "label"
                        ? "Category"
                        : field === "price_cents"
                          ? "Price"
                          : field === "currency"
                            ? "Currency"
                            : "Price basis"}
                      <input
                        type={field === "price_cents" ? "number" : "text"}
                        min={field === "price_cents" ? "0" : undefined}
                        step={field === "price_cents" ? "0.01" : undefined}
                        placeholder={
                          field === "currency"
                            ? "BZD / USD / blank"
                            : field === "price_basis"
                              ? "Per plot / per ¼ acre"
                              : ""
                        }
                        value={
                          field === "price_cents"
                            ? c.price_cents === null
                              ? ""
                              : c.price_cents / 100
                            : (c[field] ?? "")
                        }
                        onChange={(e) =>
                          updateCategories(
                            categories.map((item, index) =>
                              index === i
                                ? {
                                    ...item,
                                    [field]:
                                      field === "price_cents"
                                        ? e.target.value
                                          ? Math.round(
                                              Number(e.target.value) * 100,
                                            )
                                          : null
                                        : e.target.value || null,
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {map && (
            <div className="csv-actions">
              <button
                className="secondary"
                onClick={() =>
                  download(
                    "plot-register.csv",
                    "plot_key,plot_number,area_value,area_unit,category_key,price,currency,price_basis,dimensions\n" +
                      map.plots
                        .map((p) =>
                          [
                            p.key,
                            p.number ?? "",
                            p.area_value ?? "",
                            p.area_unit ?? "",
                            p.category_key ?? "",
                            "",
                            "",
                            "",
                            p.dimensions ?? "",
                          ]
                            .map((v) => `"${String(v).replaceAll('"', '""')}"`)
                            .join(","),
                        )
                        .join("\n"),
                    "text/csv",
                  )
                }
              >
                Download plot spreadsheet
              </button>
              <label className="studio-button secondary">
                Import completed CSV
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => void csv(e)}
                />
              </label>
              <label>
                Apply category to all plots
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value)
                      setMap({
                        ...map,
                        plots: map.plots.map((p) => ({
                          ...p,
                          category_key: e.target.value,
                        })),
                      });
                    e.target.value = "";
                  }}
                >
                  <option value="">Choose category…</option>
                  {categories.map((c) => (
                    <option value={c.key} key={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </section>
        <section className="studio-card export-card">
          <div>
            <h2>4. Export to Project Admin</h2>
            <p>
              The package carries shapes, plot data and its display image. Admin
              chooses the tenant, project and phase.
            </p>
            <small>
              Import creates a draft. Existing sales records and pricing are
              preserved on repeat imports.
            </small>
          </div>
          <button disabled={!map || busy} onClick={save}>
            Export map package
          </button>
        </section>
        <footer>
          Wamule Map Studio · Independent preparation · No sign-in or backend
          credentials
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Studio />);
