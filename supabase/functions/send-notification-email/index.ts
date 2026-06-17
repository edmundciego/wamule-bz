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

  const results = [];
  for (const email of emails as EmailNotification[]) {
    const result = await sendEmail(email, { resendApiKey, fromAddress, fromName, replyTo });
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
  config: { resendApiKey: string; fromAddress: string; fromName: string; replyTo: string },
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

function formatRecipient(name: string | null, email: string) {
  const cleanName = String(name ?? "").trim();
  return cleanName ? `${cleanName} <${email}>` : email;
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}
