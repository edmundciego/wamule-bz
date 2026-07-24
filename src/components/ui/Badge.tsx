import { cn } from "../../lib/utils";

const toneMap = {
  green: "border-success/25 bg-success/10 text-success",
  amber: "border-warning/25 bg-accent-soft text-warning",
  red: "border-danger/20 bg-danger/10 text-danger",
  blue: "border-info/20 bg-info/10 text-info",
  brown: "border-secondary/20 bg-secondary-soft text-secondary",
  slate: "border-slate/20 bg-slate/10 text-slate",
  gray: "border-border bg-muted text-slate",
};

export type BadgeTone = keyof typeof toneMap;

export function Badge({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold leading-none", toneMap[tone])}>
      {children}
    </span>
  );
}
