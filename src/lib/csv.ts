type CsvValue = string | number | boolean | null | undefined;

export function exportCsv({
  filename,
  columns,
  rows,
}: {
  filename: string;
  columns: Array<{ header: string; accessor: (row: Record<string, CsvValue>) => CsvValue }>;
  rows: Array<Record<string, CsvValue>>;
}) {
  const header = columns.map((column) => escapeCsvValue(column.header)).join(",");
  const body = rows
    .map((row) => columns.map((column) => escapeCsvValue(column.accessor(row))).join(","))
    .join("\n");
  const blob = new Blob([[header, body].filter(Boolean).join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function reportFileName(reportName: string, date = new Date()) {
  const stamp = date.toISOString().slice(0, 10);
  return `wamule-${reportName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${stamp}.csv`;
}

function escapeCsvValue(value: CsvValue) {
  const normalized = value ?? "";
  return `"${String(normalized).replaceAll('"', '""')}"`;
}
