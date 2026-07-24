import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";

export function DataManagementPanel({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  if (!isSuperAdmin) return null;

  return <Card className="border-red-300 bg-red-50/65">
    <CardHeader>
      <div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-red-100 text-red-800"><ShieldAlert className="h-5 w-5" /></div><div><CardTitle>Restricted data maintenance</CardTitle><p className="mt-1 text-sm text-red-900/80">Permanent purge is disabled until an approved database foundation exists.</p></div></div>
    </CardHeader>
    <CardContent className="grid gap-3 text-sm text-red-950"><p>Customer, contract, reservation, payment, receipt, and document history must not be removed through routine settings. Use the approved correction, cancellation, archival, or accountability workflows instead.</p><p className="font-medium">Any exceptional maintenance request requires a separately approved manual process and must not be introduced through an application migration or automatic deployment.</p></CardContent>
  </Card>;
}
