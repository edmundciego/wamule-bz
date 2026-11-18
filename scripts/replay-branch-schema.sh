#!/usr/bin/env bash
# Rebuild the application schema using only files in this checkout.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

db_url="${SCHEMA_QUERY_DATABASE_URL:?Set SCHEMA_QUERY_DATABASE_URL to a disposable local PostgreSQL URL}"
python3 - <<'PY'
import os
from urllib.parse import urlsplit

url = urlsplit(os.environ["SCHEMA_QUERY_DATABASE_URL"])
if url.scheme not in ("postgres", "postgresql") or url.hostname not in ("127.0.0.1", "localhost", "::1") or url.query:
    raise SystemExit("Use a disposable loopback PostgreSQL URL without connection overrides.")
PY

run_sql() {
  psql "$db_url" -X -q -v ON_ERROR_STOP=1 "$@"
}

if [[ "$(run_sql -tA -c "select to_regclass('public.applications') is null and current_setting('server_version_num')::int between 170000 and 179999")" != "t" ]]; then
  echo "Branch replay requires a fresh PostgreSQL 17 Supabase database." >&2
  exit 1
fi

run_sql -f wamuale_supabase_foundation_migration.sql
previous_version=""
while IFS=$'\t' read -r name migration; do
  version="${name%%_*}"
  if [[ "$version" == "$previous_version" ]]; then
    echo "Duplicate migration version $version in branch replay." >&2
    exit 1
  fi
  previous_version="$version"
  case "$version" in
    20261016054341)
      # The historical Hopkins workflow migration expects an existing example project.
      run_sql -f scripts/replay-fixtures/hopkins-workflow-precondition.sql
      ;;
    20261112040000)
      # The reviewed 20261114054243 repair covers the narrow role-claim changes.
      continue
      ;;
  esac
  printf 'Replaying %s\n' "$name"
  run_sql -f "$migration"
done < <(
  for file in supabase/migrations_archive/bootstrap/*.sql supabase/migrations/*.sql; do
    printf '%s\t%s\n' "${file##*/}" "$file"
  done | LC_ALL=C sort
)
