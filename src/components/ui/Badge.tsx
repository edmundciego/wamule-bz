import { cn } from "../../lib/utils";

const toneMap = {
  green: "border-sage/35 bg-sage/15 text-primary",
  amber: "border-copper/30 bg-copper/10 text-copper",
  red: "border-rose-200 bg-rose-50 text-rose-800",
  blue: "border-primary/20 bg-primary/10 text-primary",
  gray: "border-border bg-ivory text-slate",
};

export function Badge({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: keyof typeof toneMap;
}) {
  return (
    <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-xs font-medium", toneMap[tone])}>
      {children}
    </span>
  );
}
