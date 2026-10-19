// Supabase may cap a response below the requested page size. Advance by the
// rows actually received, and require exact counts instead of silently
// comparing/importing an incomplete phase.
export async function readMapWorkspaceRows(fetchPage) {
  const rows = [];
  let expected = null;
  while (rows.length < 50000) {
    const result = await fetchPage(rows.length, rows.length + 499);
    if (result.error)
      return {
        data: null,
        error: {
          code: result.error.code ?? "UNKNOWN",
          message: result.error.message,
        },
      };
    if (!Number.isInteger(result.count) || result.count < 0)
      throw new Error("Could not verify the workspace row count.");
    if (expected !== null && expected !== result.count)
      throw new Error(
        "Workspace changed while loading. Refresh the map comparison.",
      );
    expected = result.count;
    rows.push(...(result.data ?? []));
    if (rows.length === expected) return { data: rows, error: null };
    if (!result.data?.length || rows.length > expected)
      throw new Error(
        "The workspace response was incomplete. Refresh before importing.",
      );
  }
  throw new Error(
    "The phase has more than 50,000 records. Narrow the workspace before importing.",
  );
}
