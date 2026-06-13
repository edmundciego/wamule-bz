import { AlertCircle, Loader2 } from "lucide-react";
import { Card } from "./Card";

export function LoadingState({ label = "Loading data" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <Card className="p-6 text-center">
      <p className="font-medium">{title}</p>
      {detail ? <p className="mt-1 text-sm text-muted-foreground">{detail}</p> : null}
    </Card>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <AlertCircle className="h-4 w-4" />
      {message}
    </div>
  );
}
