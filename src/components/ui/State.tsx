import { AlertCircle, Loader2 } from "lucide-react";
import { Card } from "./Card";

export function LoadingState({ label = "Loading data" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <Card className="border-dashed p-6 text-center">
      <p className="font-medium">{title}</p>
      {detail ? <p className="mt-1 text-sm text-muted-foreground">{detail}</p> : null}
    </Card>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-danger/20 bg-danger/10 p-4 text-sm text-danger" role="alert">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}
