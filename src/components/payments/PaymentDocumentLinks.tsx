import { useState } from "react";
import { supabase } from "../../lib/supabase";
import type { PaymentDocument } from "../../types/database";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";

type PaymentDocumentSummary = Pick<
  PaymentDocument,
  "id" | "document_type" | "file_path" | "original_file_name" | "created_at"
>;

export function PaymentDocumentLinks({ documents }: { documents?: PaymentDocumentSummary[] | null }) {
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; document: PaymentDocumentSummary } | null>(null);
  const hasDocuments = Boolean(documents?.length);

  async function openDocument(document: PaymentDocumentSummary) {
    setError(null);
    const { data, error: signedUrlError } = await supabase.storage
      .from("payment-documents")
      .createSignedUrl(document.file_path, 300);
    if (signedUrlError) {
      setError(signedUrlError.message);
      return;
    }
    setPreview({ url: data.signedUrl, document });
  }

  if (!hasDocuments) {
    return <Badge tone="gray">No document</Badge>;
  }

  return (
    <div className="grid gap-2">
      {documents?.map((document) => (
        <div key={document.id} className="flex flex-wrap items-center gap-2">
          <Badge tone="blue">{document.document_type}</Badge>
          <Button type="button" variant="ghost" className="h-8 px-2" onClick={() => void openDocument(document)}>
            View {document.original_file_name}
          </Button>
        </div>
      ))}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
      {preview ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-primary/70 p-4" role="dialog" aria-modal="true">
          <div className="grid max-h-[90vh] w-full max-w-5xl gap-3 rounded-lg bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b pb-3">
              <div>
                <p className="font-medium text-primary">{preview.document.original_file_name}</p>
                <p className="text-xs text-muted-foreground">{preview.document.document_type}</p>
              </div>
              <div className="flex gap-2">
                <a
                  className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium text-primary hover:bg-muted"
                  href={preview.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open tab
                </a>
                <Button type="button" variant="secondary" onClick={() => setPreview(null)}>
                  Close
                </Button>
              </div>
            </div>
            <DocumentPreview url={preview.url} fileName={preview.document.original_file_name} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DocumentPreview({ url, fileName }: { url: string; fileName: string }) {
  const lowerName = fileName.toLowerCase();
  if (/\.(png|jpe?g|webp|gif)$/.test(lowerName)) {
    return (
      <div className="max-h-[75vh] overflow-auto rounded-md bg-muted p-2">
        <img src={url} alt={fileName} className="mx-auto max-h-[72vh] max-w-full rounded-md object-contain" />
      </div>
    );
  }

  if (lowerName.endsWith(".pdf")) {
    return <iframe title={fileName} src={url} className="h-[75vh] w-full rounded-md border" />;
  }

  return (
    <div className="rounded-md border bg-muted p-6 text-sm text-muted-foreground">
      Native preview is not available for this file type. Use Open tab to view or download it.
    </div>
  );
}
