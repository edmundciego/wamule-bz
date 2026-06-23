import { AlertCircle, CheckCircle2, Info, ListChecks, Sparkles, TriangleAlert } from "lucide-react";
import { Badge, type BadgeTone } from "./Badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./Card";
import { cn } from "../../lib/utils";
import type { SmartInsight, SmartInsightTone } from "../../lib/smartInsights";

const toneStyles: Record<SmartInsightTone, { panel: string; icon: string; badge: BadgeTone; label: string }> = {
  info: {
    panel: "border-info/15 bg-info/10",
    icon: "text-info",
    badge: "blue",
    label: "Info",
  },
  warning: {
    panel: "border-warning/25 bg-accent-soft",
    icon: "text-warning",
    badge: "amber",
    label: "Warning",
  },
  danger: {
    panel: "border-danger/20 bg-danger/10",
    icon: "text-danger",
    badge: "red",
    label: "Risk Flag",
  },
  success: {
    panel: "border-success/20 bg-success/10",
    icon: "text-success",
    badge: "green",
    label: "Current",
  },
  action: {
    panel: "border-primary/15 bg-primary-soft",
    icon: "text-primary",
    badge: "brown",
    label: "Action",
  },
};

export function SmartInsightsPanel({
  title,
  description,
  insights,
  compact = false,
  className,
}: {
  title: string;
  description?: string;
  insights: SmartInsight[];
  compact?: boolean;
  className?: string;
}) {
  const visibleInsights = insights.length ? insights : [{
    title: "No insights to show.",
    description: "There are no rule-based flags for the current data.",
    tone: "info" as const,
  }];

  return (
    <Card className={className}>
      <CardHeader className={compact ? "p-4 pb-3" : undefined}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md border border-primary/15 bg-primary-soft p-2 text-primary">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("grid gap-2", compact ? "p-4 pt-0" : undefined)}>
        {visibleInsights.map((insight, index) => (
          <SmartInsightItem key={`${insight.title}-${index}`} insight={insight} compact={compact} />
        ))}
      </CardContent>
    </Card>
  );
}

export function SmartInsightList({ insights, compact = false }: { insights: SmartInsight[]; compact?: boolean }) {
  const visibleInsights = insights.length ? insights : [{
    title: "No insights to show.",
    description: "There are no rule-based flags for the current data.",
    tone: "info" as const,
  }];

  return (
    <div className="grid gap-2">
      {visibleInsights.map((insight, index) => (
        <SmartInsightItem key={`${insight.title}-${index}`} insight={insight} compact={compact} />
      ))}
    </div>
  );
}

function SmartInsightItem({ insight, compact }: { insight: SmartInsight; compact: boolean }) {
  const tone = toneStyles[insight.tone];
  const Icon = iconForTone(insight.tone);

  return (
    <div className={cn("rounded-md border p-3 text-sm", tone.panel, compact ? "p-2.5" : "")}>
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone.icon)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 max-w-full break-words font-medium text-foreground">{insight.title}</p>
            <div className="flex max-w-full flex-wrap gap-2">
              {insight.metadata ? <Badge tone="gray">{insight.metadata}</Badge> : null}
              <Badge tone={tone.badge}>{insight.actionLabel ?? tone.label}</Badge>
            </div>
          </div>
          <p className="mt-1 break-words text-muted-foreground">{insight.description}</p>
        </div>
      </div>
    </div>
  );
}

function iconForTone(tone: SmartInsightTone) {
  if (tone === "danger") return AlertCircle;
  if (tone === "warning") return TriangleAlert;
  if (tone === "success") return CheckCircle2;
  if (tone === "action") return ListChecks;
  return Info;
}
