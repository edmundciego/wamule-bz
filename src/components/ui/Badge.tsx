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

const statusToneMap: Record<string, BadgeTone> = {
  Available: "green",
  Reserved: "amber",
  Sold: "slate",
  Blocked: "red",
  Unavailable: "red",
  New: "blue",
  "Pending Review": "amber",
  "In Review": "blue",
  "Missing Info": "amber",
  "Missing Information": "amber",
  Approved: "green",
  Rejected: "red",
  Declined: "red",
  "New Lead": "blue",
  Contacted: "blue",
  Interested: "green",
  "Family Decision": "amber",
  "Site Visit Scheduled": "blue",
  "Deposit Pending": "amber",
  "Deposit Paid": "green",
  "Payment Plan Review": "amber",
  Draft: "gray",
  "Deposit Submitted": "blue",
  "Deposit Confirmed": "green",
  "Converted to Application": "green",
  "Converted to Contract": "green",
  Expired: "amber",
  Cancelled: "gray",
  Released: "gray",
  "Not Requested": "gray",
  Pending: "amber",
  "Proof Submitted": "blue",
  Confirmed: "green",
  Waived: "brown",
  "Not Started": "gray",
  "In Progress": "blue",
  Drafting: "blue",
  "Ready For Review": "amber",
  "Sent For Signature": "blue",
  Signed: "green",
  "Missing Documents": "amber",
  Complete: "green",
  Ready: "amber",
  "Handed Off": "green",
  Active: "green",
  "Contract Started": "blue",
  "Closed/Won": "green",
  "Lost/Inactive": "gray",
  Current: "green",
  "Due Soon": "amber",
  Overdue: "red",
  "Missing Proof": "amber",
  Completed: "green",
  Missing: "amber",
  Uploaded: "blue",
};

export function statusBadgeTone(status: string | null | undefined): BadgeTone {
  if (!status) return "gray";
  return statusToneMap[status] ?? "gray";
}

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
