import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const feedbackTypes = new Set(["Bug", "Question", "Feature Request", "Data Issue", "Other"]);
const priorities = new Set(["Low", "Normal", "High", "Urgent"]);

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
    .select("role, email, full_name")
    .eq("user_id", currentUserData.user.id)
    .maybeSingle();

  if (profileError) return json({ error: profileError.message }, 500);
  if (!["Super Admin", "Admin", "Staff", "Read Only"].includes(String(currentProfile?.role ?? ""))) {
    return json({ error: "Only internal users can submit feedback." }, 403);
  }

  const body = await request.json().catch(() => ({})) as {
    feedback_type?: string;
    priority?: string;
    page_url?: string;
    message?: string;
  };

  const feedbackType = feedbackTypes.has(String(body.feedback_type)) ? String(body.feedback_type) : "Other";
  const priority = priorities.has(String(body.priority)) ? String(body.priority) : "Normal";
  const message = String(body.message ?? "").trim();
  if (!message) return json({ error: "Feedback message is required." }, 400);

  const submittedByEmail = String(currentProfile?.email ?? currentUserData.user.email ?? "").trim() || null;
  const { data: feedback, error: feedbackError } = await supabase
    .from("developer_feedback")
    .insert({
      submitted_by: currentUserData.user.id,
      submitted_by_email: submittedByEmail,
      feedback_type: feedbackType,
      priority,
      page_url: String(body.page_url ?? "").slice(0, 1000),
      message: message.slice(0, 5000),
      status: "New",
    })
    .select("*")
    .single();

  if (feedbackError) return json({ error: feedbackError.message }, 500);

  const recipient = await developerFeedbackRecipient(supabase);
  let notification = null;
  if (recipient) {
    const { data, error } = await supabase
      .from("email_notifications")
      .insert({
        recipient_email: recipient,
        recipient_name: "Developer Support",
        subject: `[Wamule ${priority}] ${feedbackType}`,
        body: feedbackEmailBody({
          name: String(currentProfile?.full_name ?? submittedByEmail ?? "Internal user"),
          email: submittedByEmail,
          feedbackType,
          priority,
          pageUrl: String(body.page_url ?? ""),
          message,
        }),
        notification_type: "Developer Feedback",
        related_table: "developer_feedback",
        related_record_id: String(feedback.id),
        status: "Pending",
        created_by: currentUserData.user.id,
      })
      .select("*")
      .single();

    if (!error) notification = data;
  }

  return json({
    feedback,
    notification,
    message: recipient
      ? "Feedback saved and developer notification queued."
      : "Feedback saved. Developer notification email is not configured yet.",
  });
});

async function developerFeedbackRecipient(supabase: ReturnType<typeof createClient>) {
  const secretRecipient = String(Deno.env.get("DEVELOPER_FEEDBACK_EMAIL") ?? "").trim();
  if (secretRecipient) return secretRecipient;

  const { data } = await supabase
    .from("notification_settings")
    .select("admin_email, is_active")
    .eq("notification_type", "Developer Feedback")
    .maybeSingle();

  if (data?.is_active && data.admin_email) return String(data.admin_email).trim();
  return "";
}

function feedbackEmailBody({
  name,
  email,
  feedbackType,
  priority,
  pageUrl,
  message,
}: {
  name: string;
  email: string | null;
  feedbackType: string;
  priority: string;
  pageUrl: string;
  message: string;
}) {
  return [
    "New Wamule Development feedback was submitted.",
    "",
    `Submitted by: ${name}`,
    `Email: ${email ?? "Not available"}`,
    `Type: ${feedbackType}`,
    `Priority: ${priority}`,
    `Page: ${pageUrl || "Not captured"}`,
    "",
    "Message:",
    message,
  ].join("\n");
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}
