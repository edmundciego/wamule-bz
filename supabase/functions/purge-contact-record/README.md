# Purge function — disabled

This function is intentionally a disabled 503 endpoint. The previous purge
implementation depended on database RPCs and cleanup tables that are not part
of the current migration chain, and it conflicts with the immutable payment
correction model.

Do not deploy a destructive implementation until an approved replacement
migration and isolated-database verification exist. The historical
implementation remains available in git history under commit `00941e7` for
review only.
