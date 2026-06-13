import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

Deno.serve(async () => {
  const { data: jobs, error: jobError } = await supabase
    .from("receipt_jobs")
    .select("id, transaction_id, attempts")
    .eq("status", "Pending")
    .order("created_at", { ascending: true })
    .limit(10);

  if (jobError) {
    return Response.json({ error: jobError.message }, { status: 500 });
  }

  const processed: Array<{ job_id: number; transaction_id: number; status: string }> = [];

  for (const job of jobs ?? []) {
    await supabase.from("receipt_jobs").update({ status: "Processing", attempts: job.attempts + 1 }).eq("id", job.id);

    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select("*, customers(first_name, last_name), contracts(id, parcel_id, final_purchase_price, parcels(lot_number))")
      .eq("id", job.transaction_id)
      .single();

    if (transactionError) {
      await supabase.from("receipt_jobs").update({ status: "Failed", error_message: transactionError.message }).eq("id", job.id);
      processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Failed" });
      continue;
    }

    const receiptLines = [
      "Wamuale Development",
      `Receipt: ${transaction.receipt_number}`,
      `Customer: ${transaction.customers.first_name} ${transaction.customers.last_name}`,
      `Lot: ${transaction.contracts?.parcels?.lot_number ?? "N/A"}`,
      `Transaction type: ${transaction.transaction_type}`,
      `Amount paid: ${transaction.amount}`,
      `Collection method: ${transaction.collection_method}`,
      `Bank reference: ${transaction.bank_reference ?? "N/A"}`,
      `Payment date: ${transaction.created_at}`,
      `Authorized by: ${transaction.authorized_by}`,
    ];

    const path = `${transaction.customer_id}/${transaction.receipt_number}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("receipts")
      .upload(path, new Blob([createSimplePdf(receiptLines)], { type: "application/pdf" }), {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      await supabase.from("receipt_jobs").update({ status: "Failed", error_message: uploadError.message }).eq("id", job.id);
      processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Failed" });
      continue;
    }

    await supabase.from("transactions").update({ receipt_file_path: path }).eq("id", transaction.id);
    await supabase.from("receipt_jobs").update({ status: "Completed", error_message: null }).eq("id", job.id);
    processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Completed" });
  }

  return Response.json({ processed });
});

function createSimplePdf(lines: string[]) {
  const escapedLines = lines.map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"));
  const textCommands = escapedLines.map((line, index) => `BT /F1 12 Tf 72 ${740 - index * 18} Td (${line}) Tj ET`).join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${textCommands.length} >> stream\n${textCommands}\nendstream endobj`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += `${object}\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}
