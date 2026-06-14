import { formatFileSize, type PreparedUploadFile } from "../../lib/uploads";

export function UploadFileSummary({
  file,
  status,
}: {
  file: PreparedUploadFile | null;
  status?: string | null;
}) {
  if (!file && !status) return null;

  return (
    <div className="grid gap-1 rounded-md border bg-white p-3 text-xs text-muted-foreground">
      {file ? (
        <>
          <p className="font-medium text-primary">{file.originalFile.name}</p>
          <p>Original size: {formatFileSize(file.originalSize)}</p>
          {file.wasCompressed ? (
            <>
              <p>Compressed size: {formatFileSize(file.uploadSize)}</p>
              <p>Compression savings: {file.savingsPercent}%</p>
            </>
          ) : (
            <p>Upload size: {formatFileSize(file.uploadSize)}</p>
          )}
        </>
      ) : null}
      {status ? <p className={status.toLowerCase().includes("failed") || status.toLowerCase().includes("large") || status.toLowerCase().includes("unsupported") ? "text-red-700" : ""}>{status}</p> : null}
    </div>
  );
}
