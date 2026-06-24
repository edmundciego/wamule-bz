import { type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "accent" | "outline" | "ghost" | "destructive" | "danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover hover:shadow-[var(--shadow-button)]",
  secondary: "bg-secondary text-white shadow-sm hover:bg-secondary-hover hover:shadow-[var(--shadow-button)]",
  accent: "bg-accent text-foreground shadow-sm hover:bg-accent-hover hover:text-white hover:shadow-[var(--shadow-button)]",
  outline: "border border-border bg-card text-primary shadow-sm hover:border-primary/30 hover:bg-primary-soft hover:shadow-[var(--shadow-button)]",
  ghost: "text-primary hover:bg-primary-soft hover:text-primary hover:shadow-none",
  destructive: "bg-danger text-white shadow-sm hover:bg-danger/90 hover:shadow-[var(--shadow-button)]",
  danger: "bg-danger text-white shadow-sm hover:bg-danger/90 hover:shadow-[var(--shadow-button)]",
};

export function Button({ className, variant = "primary", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "focus-ring inline-flex min-h-10 min-w-0 max-w-full items-center justify-center gap-2 whitespace-normal rounded-md px-4 py-2 text-center text-sm font-semibold leading-tight transition disabled:pointer-events-none disabled:opacity-50",
        "duration-150 ease-out hover:-translate-y-px active:translate-y-0",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
