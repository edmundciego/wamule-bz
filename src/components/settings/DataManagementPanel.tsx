import { AlertTriangle, Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { Field, Input, Textarea } from "../ui/Field";
import { ErrorState, LoadingState } from "../ui/State";
import { edgeFunctionErrorMessage } from "../../lib/functions";
import { supabase } from "../../lib/supabase";

type RootType = "lead" | "application" | "customer";
type RecordMatch = { root_type: RootType; root_id: string; display_name: string; email: string | null; phone: string | null; created_at?: string };
type Preview = { display_name: string; counts: Record<string, number>; linked_auth_user_id?: string | null };

export function DataManagementPanel({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecordMatch[]>([]);
  const [selected, setSelected] = useState<RecordMatch | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [possible, setPossible] = useState<RecordMatch[]>([]);
  const [reason, setReason] = useState("");
  const [confirmedTestData, setConfirmedTestData] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [typedPurge, setTypedPurge] = useState("");
  const [typedFinancial, setTypedFinancial] = useState("");
  const [removeLinkedAuth, setRemoveLinkedAuth] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const financial = useMemo(() => Boolean(preview && ["contracts", "payments", "payment_documents", "payment_requests"].some((key) => Number(preview.counts[key] ?? 0) > 0)), [preview]);

  if (!isSuperAdmin) return null;

  async function invoke(body: Record<string, unknown>) {
    const { data, error: functionError } = await supabase.functions.invoke("purge-contact-record", { body });
    if (functionError) throw new Error(await edgeFunctionErrorMessage(functionError));
    if (data?.error) throw new Error(String(data.error));
    return data;
  }

  async function search() {
    setWorking(true); setError(null); setMessage(null);
    try { const data = await invoke({ action: "search", query }); setResults(data.records ?? []); }
    catch (nextError) { setError((nextError as Error).message); }
    finally { setWorking(false); }
  }

  async function choose(record: RecordMatch) {
    setWorking(true); setError(null); setMessage(null); setSelected(record); setPreview(null); setPossible([]);
    try {
      const data = await invoke({ action: "preview", root_type: record.root_type, root_id: record.root_id });
      setPreview(data.preview); setPossible(data.possible_related_records ?? []);
    } catch (nextError) { setError((nextError as Error).message); }
    finally { setWorking(false); }
  }

  async function purge() {
    if (!selected || !preview) return;
    setWorking(true); setError(null); setMessage(null);
    try {
      const data = await invoke({ action: "execute", root_type: selected.root_type, root_id: selected.root_id, reason, confirmation: confirmedTestData, typed_name: typedName, typed_purge: typedPurge, typed_financial_confirmation: typedFinancial, remove_linked_auth: removeLinkedAuth });
      const cleanup = data.storage_cleanup as { completed?: boolean; warnings?: string[] } | undefined;
      setMessage(`Purge ${data.purge_reference} completed. ${cleanup?.completed === false ? `Database records were removed, but storage needs follow-up: ${(cleanup.warnings ?? []).join(" ")}` : "Connected database and storage records were removed."}`);
      setResults([]); setSelected(null); setPreview(null); setPossible([]); setReason(""); setConfirmedTestData(false); setTypedName(""); setTypedPurge(""); setTypedFinancial(""); setRemoveLinkedAuth(false);
    } catch (nextError) { setError((nextError as Error).message); }
    finally { setWorking(false); }
  }

  return <div className="grid gap-6">
    <Card className="border-red-300 bg-red-50/65">
      <CardHeader>
        <div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-red-100 text-red-800"><ShieldAlert className="h-5 w-5" /></div><div><CardTitle>Danger Zone</CardTitle><p className="mt-1 text-sm text-red-900/80">Permanently remove a selected person and connected operational records. This action is intended for test data or records created in error.</p></div></div>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm text-red-950"><p>Real customer records should normally be closed, voided, cancelled, archived, deactivated, or anonymized. This tool is not routine record handling.</p><p className="font-medium">Only Super Admins can preview or run a purge. Every completed purge receives a minimal accountability audit record.</p></CardContent>
    </Card>
    {error ? <ErrorState message={error} /> : null}
    {message ? <div className="crm-success-panel p-4 text-sm" role="status">{message}</div> : null}
    <Card><CardHeader><CardTitle>Purge Test or Incorrect Record</CardTitle><p className="mt-1 text-sm text-muted-foreground">Search by name, email, or phone, then choose one exact record ID. Shared contact details are shown for review only and are never included automatically.</p></CardHeader><CardContent className="grid gap-4">
      <div className="flex flex-col gap-2 sm:flex-row"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a name, email, or phone" aria-label="Search records to purge" /><Button type="button" onClick={() => void search()} disabled={working || query.trim().length < 2}><Search className="h-4 w-4" />{working ? "Searching..." : "Find records"}</Button></div>
      {working && !preview ? <LoadingState label="Checking the selected record" /> : null}
      {results.length ? <div className="divide-y rounded-md border">{results.map((record) => <button key={`${record.root_type}-${record.root_id}`} type="button" onClick={() => void choose(record)} className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-3 text-left hover:bg-primary-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"><span><strong>{record.display_name}</strong><span className="ml-2 text-xs text-muted-foreground">{record.root_type} · ID {record.root_id}</span></span><span className="text-xs text-muted-foreground">{record.email || record.phone || "No email or phone"}</span></button>)}</div> : null}
    </CardContent></Card>
    {selected && preview ? <Card className="border-red-200"><CardHeader><CardTitle>Permanent deletion preview: {preview.display_name}</CardTitle><p className="mt-1 text-sm text-muted-foreground">Only the exact selected record and records connected through current relational links will be removed.</p></CardHeader><CardContent className="grid gap-5">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(preview.counts).filter(([, count]) => Number(count) > 0).map(([label, count]) => <div key={label} className="rounded-md border bg-card px-3 py-2 text-sm"><strong>{count}</strong> {label.replaceAll("_", " ")}</div>)}</div>
      {possible.length ? <div className="crm-warning-panel p-4"><p className="font-medium">Possible related records requiring confirmation</p><p className="mt-1 text-sm">These share an email or phone number but are not included in this purge. Select one explicitly and preview it separately if it is also test data.</p><ul className="mt-2 list-disc pl-5 text-sm">{possible.slice(0, 8).map((record) => <li key={`${record.root_type}-${record.root_id}`}>{record.display_name} ({record.root_type} · ID {record.root_id})</li>)}</ul></div> : null}
      {financial ? <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-950"><div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="font-semibold">Financial and contract history detected</p><p className="mt-1">This purge will remove contract, payment, receipt/document, or payment-request history for test data only. A second explicit confirmation is required.</p></div></div></div> : null}
      {preview.linked_auth_user_id ? <label className="flex gap-2 text-sm"><input type="checkbox" checked={removeLinkedAuth} onChange={(event) => setRemoveLinkedAuth(event.target.checked)} /><span>Also remove the linked login account. This never removes the signed-in Super Admin or the last Super Admin.</span></label> : null}
      <Field label="Required reason"><Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: training record created during staff onboarding" /></Field>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmedTestData} onChange={(event) => setConfirmedTestData(event.target.checked)} /><span>I confirm this is test data or a record created in error.</span></label>
      <Field label={`Enter the exact display name: ${preview.display_name}`}><Input value={typedName} onChange={(event) => setTypedName(event.target.value)} /></Field>
      <Field label="Type PURGE to permanently remove this record"><Input value={typedPurge} onChange={(event) => setTypedPurge(event.target.value)} /></Field>
      {financial ? <Field label="Type PURGE FINANCIAL HISTORY to confirm removal of financial history"><Input value={typedFinancial} onChange={(event) => setTypedFinancial(event.target.value)} /></Field> : null}
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => { setSelected(null); setPreview(null); }}>Cancel</Button><Button type="button" variant="danger" onClick={() => void purge()} disabled={working}>{working ? "Purging..." : "Purge Test or Incorrect Record"}</Button></div>
    </CardContent></Card> : null}
  </div>;
}
