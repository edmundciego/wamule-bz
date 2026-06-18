import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, RefreshCw, RotateCcw, Send, TestTube2 } from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Textarea } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { getSessionAndProfile } from "../lib/data";
import { edgeFunctionErrorMessage } from "../lib/functions";
import { supabase } from "../lib/supabase";
import { formatDate } from "../lib/utils";
import type { AppRole, EmailNotification, EmailNotificationStatus } from "../types/database";

const statuses: EmailNotificationStatus[] = ["Pending", "Sent", "Failed", "Cancelled"];
const emailTemplates = {
  test: {
    label: "Simple Test",
    subject: "Wamule Development test email",
    body: "Good day,\n\nThis is a manual test email from the Wamule Development Email Center.\n\nPlease reply to confirm that the message was received correctly.\n\nThank you,\nWamule Development",
  },
  update: {
    label: "Customer Update",
    subject: "Wamule Development account update",
    body: "Good day,\n\nThis is a quick update from Wamule Development regarding your account file. Our team is reviewing the latest records and will contact you if any additional information is needed.\n\nPlease contact us when convenient if you have any questions or need us to confirm your account details.\n\nThank you,\nWamule Development",
  },
} as const;

export function EmailsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [activeStatus, setActiveStatus] = useState<EmailNotificationStatus>("Pending");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testTemplate, setTestTemplate] = useState<keyof typeof emailTemplates>("test");

  const { data: sessionProfile, isLoading: profileLoading } = useQuery({
    queryKey: ["email-center-session"],
    queryFn: getSessionAndProfile,
  });

  const currentRole = sessionProfile?.profile?.role as AppRole | undefined;
  const canSend = currentRole === "Super Admin" || currentRole === "Admin";

  const { data: emails, isLoading, error } = useQuery({
    queryKey: ["email-notifications"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("email_notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (queryError) throw queryError;
      return data as EmailNotification[];
    },
    enabled: canSend,
  });

  const filtered = useMemo(() => (emails ?? []).filter((email) => email.status === activeStatus), [emails, activeStatus]);
  const selected = useMemo(
    () => emails?.find((email) => email.id === selectedId) ?? filtered[0] ?? null,
    [emails, filtered, selectedId],
  );

  if (profileLoading) {
    return (
      <>
        <PageHeader title="Email Center" description="Admin-controlled notification outbox for previewing and sending system emails." />
        <LoadingState label="Checking Email Center access" />
      </>
    );
  }

  if (!canSend) {
    return (
      <>
        <PageHeader title="Email Center" description="Admin-controlled notification outbox for previewing and sending system emails." />
        <ErrorState message="Only Super Admin and Admin users can access the Email Center." />
      </>
    );
  }

  async function invokeSend(body: Record<string, unknown>) {
    setActionError(null);
    setActionMessage(null);
    setSending(true);
    const { data, error: functionError } = await supabase.functions.invoke("send-notification-email", { body });
    setSending(false);
    if (functionError) {
      setActionError(edgeFunctionErrorMessage(functionError));
      return;
    }
    if (data?.error) {
      setActionError(String(data.error));
      return;
    }
    setActionMessage(`Email processing complete. Sent: ${data?.sent ?? 0}. Failed: ${data?.failed ?? 0}.`);
    await queryClient.invalidateQueries({ queryKey: ["email-notifications"] });
  }

  async function createTestEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setActionMessage(null);
    const recipient = testEmail.trim();
    if (!recipient) {
      setActionError("Enter a recipient email for the test notification.");
      return;
    }
    const template = emailTemplates[testTemplate];
    const { data, error: insertError } = await supabase
      .from("email_notifications")
      .insert({
        recipient_email: recipient,
        recipient_name: "Test Recipient",
        subject: template.subject,
        body: template.body,
        notification_type: "Test Email",
        related_table: null,
        related_record_id: null,
        status: "Pending",
        error_message: null,
        sent_at: null,
        created_by: sessionProfile?.session?.user.id ?? null,
      })
      .select("*")
      .single();
    if (insertError) {
      setActionError(insertError.message);
      return;
    }
    setTestEmail("");
    setSelectedId(Number(data.id));
    setActiveStatus("Pending");
    setActionMessage("Test email queued. Review it before sending.");
    await queryClient.invalidateQueries({ queryKey: ["email-notifications"] });
  }

  return (
    <>
      <PageHeader
        title="Email Center"
        description="Admin-controlled notification outbox for previewing and sending system emails."
        action={
          canSend ? (
            <Button type="button" disabled={sending} onClick={() => void invokeSend({ batch: true })}>
              <Send className="h-4 w-4" />
              Process Pending Emails
            </Button>
          ) : null
        }
      />

      <div className="grid gap-6">
        {isLoading ? <LoadingState label="Loading email notifications" /> : null}
        {error ? <ErrorState message={(error as Error).message} /> : null}
        {actionError ? <ErrorState message={actionError} /> : null}
        {actionMessage ? <div className="rounded-md border border-sage/30 bg-sage/15 p-3 text-sm text-primary">{actionMessage}</div> : null}
        {!canSend ? (
          <div className="rounded-md border border-copper/30 bg-copper/10 p-3 text-sm text-copper">
            Your role can view email notifications but cannot send them.
          </div>
        ) : null}

        <Card>
          <CardHeader><CardTitle>Send Test Email</CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-3 md:grid-cols-[1fr_220px_auto]" onSubmit={(event) => void createTestEmail(event)}>
              <Field label="Recipient email">
                <Input type="email" value={testEmail} onChange={(event) => setTestEmail(event.target.value)} placeholder="admin@example.com" />
              </Field>
              <Field label="Message style">
                <select
                  className="focus-ring h-10 rounded-md border bg-white px-3 text-sm shadow-sm shadow-primary/5"
                  value={testTemplate}
                  onChange={(event) => setTestTemplate(event.target.value as keyof typeof emailTemplates)}
                >
                  {Object.entries(emailTemplates).map(([key, template]) => (
                    <option key={key} value={key}>{template.label}</option>
                  ))}
                </select>
              </Field>
              <Button type="submit" disabled={!canSend} className="self-end">
                <TestTube2 className="h-4 w-4" />
                Queue Test Email
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>Notification Outbox</CardTitle>
              <div className="flex flex-wrap gap-2">
                {statuses.map((status) => (
                  <Button key={status} type="button" variant={activeStatus === status ? "primary" : "secondary"} onClick={() => setActiveStatus(status)} className="h-9">
                    {status}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {filtered.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-left text-sm">
                    <thead className="border-b text-xs uppercase tracking-[0.12em] text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3">Recipient</th>
                        <th className="py-2 pr-3">Type</th>
                        <th className="py-2 pr-3">Subject</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3">Created</th>
                        <th className="py-2 pr-3">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filtered.map((email) => (
                        <tr key={email.id}>
                          <td className="py-3 pr-3">{email.recipient_email}</td>
                          <td className="py-3 pr-3">{email.notification_type}</td>
                          <td className="py-3 pr-3">{email.subject}</td>
                          <td className="py-3 pr-3"><Badge tone={emailStatusTone(email.status)}>{email.status}</Badge></td>
                          <td className="py-3 pr-3">{formatDate(email.created_at)}</td>
                          <td className="py-3 pr-3">
                            <Button type="button" variant={selected?.id === email.id ? "primary" : "secondary"} onClick={() => setSelectedId(email.id)}>
                              Preview
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No {activeStatus.toLowerCase()} notifications.</p>
              )}
            </CardContent>
          </Card>

          <EmailPreview email={selected} canSend={canSend} sending={sending} onSend={invokeSend} />
        </div>
      </div>
    </>
  );
}

function EmailPreview({
  email,
  canSend,
  sending,
  onSend,
}: {
  email: EmailNotification | null;
  canSend: boolean;
  sending: boolean;
  onSend: (body: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Email Preview</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        {email ? (
          <>
            <div className="grid gap-3 text-sm">
              <Meta label="To" value={email.recipient_name ? `${email.recipient_name} <${email.recipient_email}>` : email.recipient_email} />
              <Meta label="Subject" value={email.subject} />
              <Meta label="Type" value={email.notification_type} />
              <Meta label="Status" value={email.status} />
              <Meta label="Sent" value={email.sent_at ? formatDate(email.sent_at) : "Not sent"} />
              {email.error_message ? <Meta label="Error" value={email.error_message} /> : null}
            </div>
            <div className="rounded-md border border-primary/10 bg-ivory/50 p-3 text-xs leading-5 text-muted-foreground">
              Sent emails use the branded HTML wrapper with the company logo from Settings when the logo URL is public. This preview shows the editable plain-text body stored in the outbox.
            </div>
            <Textarea readOnly value={email.body} className="min-h-64" />
            {canSend ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={sending || email.status !== "Pending"}
                  onClick={() => void onSend({ email_notification_id: email.id })}
                >
                  <Mail className="h-4 w-4" />
                  Send Selected Email
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={sending || email.status !== "Failed"}
                  onClick={() => void onSend({ email_notification_id: email.id, retry_failed: true })}
                >
                  <RotateCcw className="h-4 w-4" />
                  Retry Failed Email
                </Button>
                <Button type="button" variant="secondary" disabled={sending} onClick={() => void onSend({ batch: true })}>
                  <RefreshCw className="h-4 w-4" />
                  Process Pending
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Select an email notification to preview.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-foreground">{value}</p>
    </div>
  );
}

function emailStatusTone(status: EmailNotificationStatus) {
  if (status === "Sent") return "green";
  if (status === "Failed") return "red";
  if (status === "Pending") return "amber";
  return "gray";
}
