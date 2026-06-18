import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EmailNotification = {
  id: number;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  body: string;
  notification_type: string;
  status: string;
};

type EmailBranding = {
  companyName: string;
  logoUrl: string;
  contactEmail: string;
  locationAddress: string;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const token = (request.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Missing authorization token." }, 401);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: currentUserData, error: currentUserError } = await supabase.auth.getUser(token);
  if (currentUserError || !currentUserData.user) return json({ error: "Invalid authorization token." }, 401);

  const { data: currentProfile, error: profileError } = await supabase
    .from("admin_profiles")
    .select("role")
    .eq("user_id", currentUserData.user.id)
    .maybeSingle();

  if (profileError) return json({ error: profileError.message }, 500);
  if (!["Super Admin", "Admin"].includes(String(currentProfile?.role ?? ""))) {
    return json({ error: "Only Super Admin or Admin users can send notification emails." }, 403);
  }

  const body = await request.json().catch(() => ({})) as {
    email_notification_id?: number;
    batch?: boolean;
    retry_failed?: boolean;
  };

  const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const fromAddress = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "";
  const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? "Wamule Development";
  const replyTo = Deno.env.get("EMAIL_REPLY_TO") ?? Deno.env.get("NOTIFICATION_ADMIN_EMAIL") ?? "";

  if (!resendApiKey || !fromAddress) {
    return json({ error: "Email sending is not configured. Set RESEND_API_KEY and EMAIL_FROM_ADDRESS Supabase secrets." }, 400);
  }

  let query = supabase.from("email_notifications").select("*").order("created_at", { ascending: true });
  if (body.email_notification_id) {
    query = query.eq("id", body.email_notification_id).in("status", body.retry_failed ? ["Pending", "Failed"] : ["Pending"]);
  } else if (body.batch) {
    query = query.eq("status", "Pending").limit(25);
  } else {
    return json({ error: "Provide email_notification_id or set batch to true." }, 400);
  }

  const { data: emails, error: emailError } = await query;
  if (emailError) return json({ error: emailError.message }, 500);
  if (!emails?.length) return json({ sent: 0, failed: 0, results: [] });

  const branding = await loadEmailBranding(supabase, { fromName, fromAddress });
  const results = [];
  for (const email of emails as EmailNotification[]) {
    const result = await sendEmail(email, { resendApiKey, fromAddress, fromName, replyTo, branding });
    results.push(result);
    if (result.ok) {
      await supabase
        .from("email_notifications")
        .update({ status: "Sent", error_message: null, sent_at: new Date().toISOString() })
        .eq("id", email.id);
    } else {
      await supabase
        .from("email_notifications")
        .update({ status: "Failed", error_message: result.error })
        .eq("id", email.id);
    }
  }

  return json({
    sent: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  });
});

async function sendEmail(
  email: EmailNotification,
  config: { resendApiKey: string; fromAddress: string; fromName: string; replyTo: string; branding: EmailBranding },
) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${config.fromName} <${config.fromAddress}>`,
        to: [formatRecipient(email.recipient_name, email.recipient_email)],
        subject: email.subject,
        text: email.body,
        html: renderEmailHtml(email, config.branding),
        reply_to: config.replyTo || undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { id: email.id, ok: false, error: text.slice(0, 1000) || `Resend returned ${response.status}.` };
    }

    return { id: email.id, ok: true };
  } catch (error) {
    return { id: email.id, ok: false, error: error instanceof Error ? error.message : "Unknown email send error." };
  }
}

async function loadEmailBranding(
  supabase: ReturnType<typeof createClient>,
  fallback: { fromName: string; fromAddress: string },
): Promise<EmailBranding> {
  const { data } = await supabase
    .from("business_settings")
    .select("value")
    .eq("key", "company_profile")
    .maybeSingle();
  const value = data?.value && typeof data.value === "object" ? data.value as Record<string, unknown> : {};
  return {
    companyName: cleanText(value.company_name, fallback.fromName),
    logoUrl: absoluteLogoUrl(cleanText(value.logo_url, "")),
    contactEmail: cleanText(value.contact_email, fallback.fromAddress),
    locationAddress: cleanText(value.location_address, "Dangriga Town, Belize"),
  };
}

function renderEmailHtml(email: EmailNotification, branding: EmailBranding) {
  const preheader = email.body.split(/\r?\n/).find((line) => line.trim())?.slice(0, 140) ?? email.subject;
  const accentLabel = notificationAccentLabel(email.notification_type);
  const bodyHtml = email.body
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px; line-height:1.65;">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(email.subject)}</title>
  </head>
  <body style="margin:0; padding:0; background:#f5f2ea; color:#1f2a24; font-family:Arial, Helvetica, sans-serif;">
    <span style="display:none!important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden;">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f2ea; padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px; background:#ffffff; border:1px solid #e4ddcf; border-radius:10px; overflow:hidden;">
            <tr>
              <td style="background:#18362b; padding:24px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      ${branding.logoUrl ? `<img src="${escapeHtml(branding.logoUrl)}" width="56" height="56" alt="${escapeHtml(branding.companyName)}" style="display:block; width:56px; height:56px; border-radius:8px; object-fit:cover; background:#fff;">` : ""}
                    </td>
                    <td style="vertical-align:middle; padding-left:${branding.logoUrl ? "14px" : "0"};">
                      <div style="font-size:20px; line-height:1.2; font-weight:700; color:#ffffff;">${escapeHtml(branding.companyName)}</div>
                      <div style="margin-top:6px; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#d8b36a;">${escapeHtml(accentLabel)}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 18px; color:#18362b; font-size:22px; line-height:1.3;">${escapeHtml(email.subject)}</h1>
                <div style="font-size:15px; line-height:1.65; color:#2c332f;">
                  ${bodyHtml || "<p style=\"margin:0;\">No message body provided.</p>"}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px; background:#fbfaf6; border-top:1px solid #eee7da;">
                <p style="margin:0; color:#637067; font-size:12px; line-height:1.5;">This message was sent by ${escapeHtml(branding.companyName)}. Please reply to this email if you need assistance.</p>
                <p style="margin:8px 0 0; color:#637067; font-size:12px; line-height:1.5;">${escapeHtml(branding.locationAddress)}${branding.contactEmail ? ` · ${escapeHtml(branding.contactEmail)}` : ""}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function notificationAccentLabel(type: string) {
  if (type === "Developer Feedback") return "Developer Feedback";
  if (type === "Test Email") return "Email Center Test";
  if (type === "Daily Brief") return "Daily Brief";
  if (type.includes("Payment")) return "Payment Notification";
  if (type.includes("Application")) return "Application Update";
  return "Notification";
}

function absoluteLogoUrl(value: string) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const base = Deno.env.get("PUBLIC_SITE_URL") ?? Deno.env.get("SITE_URL") ?? "";
  if (!base) return "";
  return `${base.replace(/\/$/, "")}/${value.replace(/^\//, "")}`;
}

function cleanText(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatRecipient(name: string | null, email: string) {
  const cleanName = String(name ?? "").trim();
  return cleanName ? `${cleanName} <${email}>` : email;
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}
