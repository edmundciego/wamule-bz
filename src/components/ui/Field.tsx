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
    <label className="grid gap-2 text-sm font-medium">
      <span>{label}</span>
      {children}
      {error ? <span className="text-sm font-normal text-red-700">{error}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const isFileInput = props.type === "file";

  return (
    <input
      className={cn(
        "focus-ring rounded-md border bg-white text-sm shadow-sm shadow-primary/5 disabled:bg-muted",
        isFileInput
          ? "min-h-10 cursor-pointer p-1.5 text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-copper file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-copper/90"
          : "h-10 px-3",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn("focus-ring h-10 rounded-md border bg-white px-3 text-sm shadow-sm shadow-primary/5", className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn("focus-ring min-h-24 rounded-md border bg-white px-3 py-2 text-sm shadow-sm shadow-primary/5", className)}
      {...props}
    />
  );
}
