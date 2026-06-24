import { type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid min-w-0 gap-2 text-sm font-medium text-foreground">
      <span>{label}</span>
      {children}
      {error ? <span className="text-sm font-normal text-danger">{error}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const isFileInput = props.type === "file";

  return (
    <input
      className={cn(
        "focus-ring min-w-0 max-w-full rounded-md border border-input bg-card text-sm shadow-sm shadow-primary/5 transition-colors placeholder:text-muted-foreground disabled:bg-muted disabled:text-muted-foreground",
        isFileInput
          ? "min-h-10 w-full cursor-pointer p-1.5 text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-primary-hover"
          : "h-10 w-full px-3",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn("focus-ring h-10 w-full min-w-0 max-w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm shadow-primary/5 transition-colors disabled:bg-muted disabled:text-muted-foreground", className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn("focus-ring min-h-24 w-full min-w-0 max-w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm shadow-primary/5 transition-colors placeholder:text-muted-foreground disabled:bg-muted disabled:text-muted-foreground", className)}
      {...props}
    />
  );
}
