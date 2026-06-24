import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Select } from "../components/ui/Field";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/State";
import {
  auditActionLabels,
  auditActions,
  auditEntityLabels,
  auditEntityTypes,
  formatAuditActor,
} from "../lib/audit";
import { supabase } from "../lib/supabase";
import type { AuditAction, AuditEntityType, AuditEvent } from "../types/database";

type AuditEventRecord = Omit<AuditEvent, "entity_type" | "action" | "before_data" | "after_data" | "metadata"> & {
  entity_type: string;
  action: string;
  before_data: unknown;
  after_data: unknown;
  metadata: unknown;
};

const actionToneMap: Record<AuditAction, BadgeTone> = {
  created: "green",
  updated: "blue",
  deleted: "red",
  voided: "red",
  cancelled: "gray",
  released: "amber",
  status_changed: "blue",
  assignment_changed: "blue",
  generated: "brown",
  uploaded: "blue",
  reviewed: "green",
  settings_changed: "amber",
};

function humanizeAuditValue(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function auditEntityLabel(value: string) {
  return auditEntityLabels[value as AuditEntityType] ?? humanizeAuditValue(value);
}

function auditActionLabel(value: string) {
  return auditActionLabels[value as AuditAction] ?? humanizeAuditValue(value);
}

function auditActionTone(value: string): BadgeTone {
  return actionToneMap[value as AuditAction] ?? "gray";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-BZ", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isInDateRange(value: string, from: string, to: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return true;

  if (from) {
    const fromTimestamp = new Date(`${from}T00:00:00`).getTime();
    if (!Number.isNaN(fromTimestamp) && timestamp < fromTimestamp) return false;
  }

  if (to) {
    const toTimestamp = new Date(`${to}T23:59:59`).getTime();
    if (!Number.isNaN(toTimestamp) && timestamp > toTimestamp) return false;
  }

  return true;
}

function hasJsonDetail(value: unknown) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (!hasJsonDetail(value)) return null;

  return (
    <div className="grid gap-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed text-slate">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function AuditTrailPage() {
  const [entityType, setEntityType] = useState<"all" | AuditEntityType>("all");
  const [action, setAction] = useState<"all" | AuditAction>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");

  const { data: events = [], isLoading, error } = useQuery({
    queryKey: ["audit-events"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("audit_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(250);
      if (queryError) throw queryError;
      return (data ?? []) as AuditEventRecord[];
    },
  });

  const filteredEvents = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return events.filter((event) => {
      if (entityType !== "all" && event.entity_type !== entityType) return false;
      if (action !== "all" && event.action !== action) return false;
      if (!isInDateRange(event.created_at, dateFrom, dateTo)) return false;

      if (!normalizedSearch) return true;
      const haystack = [
        event.title,
        event.summary,
        event.entity_id,
        auditEntityLabel(event.entity_type),
        auditActionLabel(event.action),
        formatAuditActor(event),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [action, dateFrom, dateTo, entityType, events, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Trail"
        description="Audit Trail records important system and staff actions for accountability."
      />

      <Card>
        <CardHeader>
          <CardTitle>Read-only history</CardTitle>
          <CardDescription>
            Audit entries are read-only history records. This page helps track who changed what and when.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_1fr_1.4fr]">
          <Field label="From">
            <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </Field>
          <Field label="Entity">
            <Select value={entityType} onChange={(event) => setEntityType(event.target.value as "all" | AuditEntityType)}>
              <option value="all">All entities</option>
              {auditEntityTypes.map((type) => (
                <option key={type} value={type}>
                  {auditEntityLabels[type]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Action">
            <Select value={action} onChange={(event) => setAction(event.target.value as "all" | AuditAction)}>
              <option value="all">All actions</option>
              {auditActions.map((auditAction) => (
                <option key={auditAction} value={auditAction}>
                  {auditActionLabels[auditAction]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Search">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search title, actor, or entity ID"
            />
          </Field>
        </CardContent>
      </Card>

      {isLoading ? <LoadingState label="Loading audit trail" /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}

      {!isLoading && !error ? (
        filteredEvents.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Audit entries</CardTitle>
              <CardDescription>
                Showing {filteredEvents.length} of {events.length} loaded entries.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="crm-table min-w-[980px]">
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>Entity</th>
                      <th>Action</th>
                      <th>Title / Summary</th>
                      <th>Actor</th>
                      <th>Entity ID</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEvents.map((event) => (
                      <tr key={event.id}>
                        <td className="whitespace-nowrap text-sm">{formatDateTime(event.created_at)}</td>
                        <td>
                          <Badge tone="slate">{auditEntityLabel(event.entity_type)}</Badge>
                        </td>
                        <td>
                          <Badge tone={auditActionTone(event.action)}>{auditActionLabel(event.action)}</Badge>
                        </td>
                        <td className="max-w-md">
                          <p className="break-words font-medium text-foreground">{event.title}</p>
                          {event.summary ? (
                            <p className="mt-1 break-words text-sm text-muted-foreground">{event.summary}</p>
                          ) : null}
                        </td>
                        <td className="max-w-[220px] break-words text-sm">{formatAuditActor(event)}</td>
                        <td className="max-w-[180px] break-all text-xs text-muted-foreground">{event.entity_id ?? "Not linked"}</td>
                        <td className="min-w-[180px]">
                          {hasJsonDetail(event.before_data) || hasJsonDetail(event.after_data) || hasJsonDetail(event.metadata) ? (
                            <details className="group">
                              <summary className="cursor-pointer text-sm font-medium text-primary hover:text-primary-hover">
                                View details
                              </summary>
                              <div className="mt-3 grid gap-3">
                                <JsonBlock label="Before" value={event.before_data} />
                                <JsonBlock label="After" value={event.after_data} />
                                <JsonBlock label="Metadata" value={event.metadata} />
                              </div>
                            </details>
                          ) : (
                            <span className="text-sm text-muted-foreground">No details</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ) : (
          <EmptyState
            title="No audit entries found"
            detail="Audit events will appear here after future staff-controlled workflows start writing entries."
          />
        )
      ) : null}
    </div>
  );
}
