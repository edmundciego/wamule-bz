// Styled Daily Operations Brief HTML email template.
//
// Table-based layout with inline styles (Outlook/Gmail safe). Mirrors the
// Wamule web CRM visual language: forest-green header, slate surfaces,
// metric cards, and priority callouts. Consumed by the send-notification-email
// dispatcher for notification_type = 'Daily Brief'.

export type DailyBriefPriority = {
  title: string;
  detail: string;
  severity: "red" | "amber";
};

export type DailyBriefEmailData = {
  subject: string;
  periodCovered: string;
  generatedAt: string;
  summary: string;
  metrics: {
    newApplications: string;
    paymentsLogged: string;
    newContracts: string;
    openActionItems: string;
    resolvedItems: string;
    outstandingBalance: string;
  };
  priorities: DailyBriefPriority[];
  activity: {
    applications: string;
    lots: string;
    contracts: string;
    payments: string;
  };
  collections: string;
};

export type DailyBriefEmailBranding = {
  companyName: string;
  locationAddress: string;
};

const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

export function escapeBriefHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const BRIEF_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];

/** "2026-09-15" (or ISO datetime) -> "15-Sept-2026". Falls back to trimmed input. */
export function formatBriefDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value.trim().slice(0, 32);
  const month = BRIEF_MONTHS[Number(match[2]) - 1];
  if (!month) return value.trim().slice(0, 32);
  return `${Number(match[3])}-${month}-${match[1]}`;
}

/** ("2026-09-14", "2026-09-15") -> "14-Sept to 15-Sept-2026". */
export function formatBriefPeriod(start: unknown, end: unknown): string {
  const first = formatBriefDate(start);
  const second = formatBriefDate(end);
  if (first && second) {
    if (first === second) return first;
    const firstParts = first.split("-");
    const secondParts = second.split("-");
    if (firstParts.length === 3 && secondParts.length === 3 && firstParts[2] === secondParts[2]) {
      return `${firstParts[0]}-${firstParts[1]} to ${second}`;
    }
    return `${first} to ${second}`;
  }
  return first || second;
}

/**
 * Inline-bold key figures (dollar amounts, leading counts) inside
 * already-escaped HTML. Entity-safe: `$` never appears in entities and the
 * leading-count anchor avoids them.
 */
export function emphasizeFigures(escapedHtml: string): string {
  return escapedHtml
    .replace(/(\$[\d,]+(?:\.\d{2})?)/g, "<strong>$1</strong>")
    .replace(/^(\d[\d,]*)/, "<strong>$1</strong>");
}

/** Multi-sentence values become • bulleted lines; single lines pass through. */
export function bulletedValue(text: string): string {
  const sentences = text.split(/(?<=\.)\s+/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length <= 1) return escapeBriefHtml(text);
  return sentences.map((sentence) => `• ${escapeBriefHtml(sentence)}`).join("<br>");
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => `<p style="margin:0 0 12px; line-height:1.6;">${escapeBriefHtml(chunk).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function metricCard(label: string, value: string, accentValue: boolean): string {
  return `<td width="50%" style="padding:0 6px 12px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td style="background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:12px 16px;">
          <div style="color:#64748b; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase;">${escapeBriefHtml(label)}</div>
          <div style="margin-top:6px; color:${accentValue ? "#166534" : "#0f172a"}; font-size:20px; font-weight:700; line-height:1.2;">${escapeBriefHtml(value)}</div>
        </td>
      </tr>
    </table>
  </td>`;
}

function sectionCard(title: string, innerHtml: string): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;">
    <tr>
      <td style="background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:16px;">
        <div style="margin:0 0 12px; color:#0f172a; font-size:14px; font-weight:700;">${escapeBriefHtml(title)}</div>
        ${innerHtml}
      </td>
    </tr>
  </table>`;
}

function activityRow(label: string, value: string): string {
  const body = value ? emphasizeFigures(bulletedValue(value)) : "—";
  return `<tr>
    <td style="padding:8px 0; border-bottom:1px solid #f1f5f9; color:#64748b; font-size:13px; vertical-align:top;">${escapeBriefHtml(label)}</td>
    <td style="padding:8px 0 8px 16px; border-bottom:1px solid #f1f5f9; color:#334155; font-size:13px; font-weight:400; line-height:1.65;">${body}</td>
  </tr>`;
}

function prioritiesHtml(priorities: DailyBriefPriority[]): string {
  if (!priorities.length) {
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:12px 16px; color:#166534; font-size:13px; line-height:1.6;">
          No open priorities need attention right now.
        </td>
      </tr>
    </table>`;
  }
  return priorities
    .map((item) => {
      const border = item.severity === "red" ? "#ef4444" : "#f59e0b";
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 8px;">
        <tr>
          <td style="background:#ffffff; border:1px solid #e2e8f0; border-left:4px solid ${border}; border-radius:8px; padding:12px 16px;">
            <div style="color:#0f172a; font-size:13px; font-weight:700;">${escapeBriefHtml(item.title)}</div>
            ${item.detail ? `<div style="margin-top:4px; color:#475569; font-size:13px; line-height:1.6;">${escapeBriefHtml(item.detail)}</div>` : ""}
          </td>
        </tr>
      </table>`;
    })
    .join("");
}

export function renderDailyBriefHtml(
  data: DailyBriefEmailData,
  branding: DailyBriefEmailBranding,
  dashboardUrl: string,
): string {
  const preheader = `Daily Operations Brief — ${data.periodCovered}`.slice(0, 140);
  const summaryInner = paragraphs(data.summary) || "<p style=\"margin:0;\">No summary recorded.</p>";
  const summaryHtml = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="background:#f1f5f9; border-radius:8px; padding:12px 16px; color:#334155; font-size:13px; line-height:1.65;">${summaryInner}</td></tr></table>`;
  const activityHtml = "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\">"
    + activityRow("Applications", data.activity.applications)
    + activityRow("Lots Updated", data.activity.lots)
    + activityRow("Contracts", data.activity.contracts)
    + activityRow("Payments", data.activity.payments)
    + "</table>";
  const collectionsBody = data.collections
    ? emphasizeFigures(bulletedValue(data.collections))
    : "No outstanding balance reported.";
  const collectionsHtml = "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\"><tr><td style=\"background:#f1f5f9; border-radius:8px; padding:12px 16px; color:#334155; font-size:13px; font-weight:400; line-height:1.65;\">"
    + collectionsBody
    + "</td></tr></table>";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeBriefHtml(data.subject)}</title>
  </head>
  <body style="margin:0; padding:0; background:#f8fafc; color:#0f172a; font-family:${FONT_STACK};">
    <span style="display:none!important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden;">${escapeBriefHtml(preheader)}</span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc; padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;">
            <tr>
              <td style="background:#166534; padding:24px; border-radius:8px 8px 0 0;">
                <div style="color:#ffffff; font-size:14px; font-weight:700; letter-spacing:1px; text-transform:uppercase;">${escapeBriefHtml(branding.companyName || "WAMULE DEVELOPMENT")}</div>
                <div style="margin-top:8px; color:#ffffff; font-size:22px; font-weight:700; line-height:1.2;">Daily Operations Brief</div>
                <div style="margin-top:8px; color:rgba(255,255,255,0.8); font-size:12px;">${escapeBriefHtml(data.periodCovered)} · Generated ${escapeBriefHtml(data.generatedAt)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 0 0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    ${metricCard("New Applications / Leads", data.metrics.newApplications, false)}
                    ${metricCard("Payments Logged ($)", data.metrics.paymentsLogged, true)}
                  </tr>
                  <tr>
                    ${metricCard("New Contracts", data.metrics.newContracts, false)}
                    ${metricCard("Open Action Items", data.metrics.openActionItems, false)}
                  </tr>
                  <tr>
                    ${metricCard("Resolved Items", data.metrics.resolvedItems, false)}
                    ${metricCard("Outstanding Balance ($)", data.metrics.outstandingBalance, true)}
                  </tr>
                </table>
                ${sectionCard("Executive Summary", summaryHtml)}
                ${sectionCard("Today's Priorities", prioritiesHtml(data.priorities))}
                ${sectionCard("Activity Breakdown", activityHtml)}
                ${sectionCard("Outstanding Collections & Balances", collectionsHtml)}
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:4px 0 20px;">
                  <tr>
                    <td align="center">
                      <a href="${escapeBriefHtml(dashboardUrl)}" style="display:inline-block; background:#166534; color:#ffffff; font-size:14px; font-weight:700; padding:12px 24px; border-radius:6px; text-decoration:none;">Open CRM Dashboard</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0; text-align:center; color:#94a3b8; font-size:12px; line-height:1.6;">
                  ${escapeBriefHtml(branding.locationAddress || "Mile 3, Hummingbird Highway, Dangriga Town, Belize")}<br>
                  Automated system email sent by ${escapeBriefHtml(branding.companyName || "Wamule Development")} CRM.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
