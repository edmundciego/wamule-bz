#!/usr/bin/env python3
"""Probe tracked migrations against an empty or candidate-baseline PG DB.

This local diagnostic is not a substitute for `supabase db reset`: it uses
embedded PostgreSQL, creates minimal Auth/Storage compatibility stubs and
optionally tests a named legacy foundation candidate. It never connects to a
linked or hosted project. Its entire database cluster is created in a
temporary directory and deleted on exit.

Exit status is 0 only when every tracked migration applies; 1 when a migration
is blocked; 2 for a probe/setup error.
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import pgserver
import psycopg
from pgserver._commands import POSTGRES_BIN_PATH


ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
PLATFORM_ROLES = ("anon", "authenticated", "service_role")
FOUNDATION_CANDIDATES = {
    "archive": ROOT / "supabase" / "migrations_archive" / "20260610_wamuale_foundation.sql",
    "root": ROOT / "wamuale_supabase_foundation_migration.sql",
}
PGCRYPTO_EXTENSION_DDL = re.compile(
    r"(?im)^\s*CREATE\s+EXTENSION(?:\s+IF\s+NOT\s+EXISTS)?\s+pgcrypto\s*;\s*$"
)
NON_CORE_PGCRYPTO_API = re.compile(
    r"(?i)\b(digest|hmac|crypt|gen_salt|gen_random_bytes|encrypt|decrypt|pgp_[a-z0-9_]+)\s*\("
)
PUBLIC_DUMP_OBJECT_HEADER = re.compile(
    r"(?m)^-- Name: (.*); Type: (.*); Schema: public; Owner: -$"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    comparison = parser.add_mutually_exclusive_group()
    comparison.add_argument(
        "--baseline",
        choices=("none", *FOUNDATION_CANDIDATES),
        default="none",
        help=(
            "start from no app baseline (default), or experimentally apply one "
            "legacy foundation candidate before the tracked migrations"
        ),
    )
    comparison.add_argument(
        "--compare-candidates",
        action="store_true",
        help="replay both candidates in separate temporary databases and diff public-schema DDL",
    )
    parser.add_argument("--diff-lines", type=int, default=200, help="maximum unified-diff lines to print")
    parser.add_argument("--emit-public-schema", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def install_platform_stubs(conn: psycopg.Connection) -> None:
    """Provide only Supabase-managed objects referenced by the SQL candidates.

    These deliberately small compatibility stubs let PostgreSQL parse and
    execute the repository SQL in isolation. They do not emulate Auth,
    Storage, Supabase extensions, grants, or Edge Runtime behavior.
    """
    with conn.cursor() as cur:
        for role in PLATFORM_ROLES:
            cur.execute(f'CREATE ROLE "{role}"')
        cur.execute("CREATE SCHEMA auth")
        cur.execute("CREATE TABLE auth.users (id uuid PRIMARY KEY)")
        cur.execute(
            "CREATE FUNCTION auth.uid() RETURNS uuid "
            "LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$"
        )
        cur.execute("CREATE SCHEMA storage")
        cur.execute(
            """
            CREATE TABLE storage.buckets (
                id text PRIMARY KEY,
                name text NOT NULL,
                public boolean NOT NULL DEFAULT false,
                file_size_limit bigint,
                allowed_mime_types text[]
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE storage.objects (
                id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                bucket_id text NOT NULL,
                name text NOT NULL
            )
            """
        )
        cur.execute("ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY")
        cur.execute(
            """
            CREATE FUNCTION storage.foldername(object_name text) RETURNS text[]
            LANGUAGE sql IMMUTABLE AS $$
                SELECT string_to_array(object_name, '/')
            $$
            """
        )


def execute_repository_sql(cur: psycopg.Cursor, sql: str) -> bool:
    """Execute SQL, omitting redundant pgcrypto install on PG 13+ only.

    pgserver's bundled PostgreSQL omits optional extension packages. The
    repository SQL uses only gen_random_uuid() from pgcrypto, which is a core
    PostgreSQL function on 13+. In that case the probe skips only the
    CREATE EXTENSION statement while retaining the actual schema SQL. Returns
    True when that compatibility path was used; older servers execute the
    original statement so a missing extension remains a real failure.
    """
    matches = list(PGCRYPTO_EXTENSION_DDL.finditer(sql))
    if not matches:
        cur.execute(sql)
        return False

    cur.execute(
        "SELECT current_setting('server_version_num')::integer, "
        "to_regprocedure('gen_random_uuid()') IS NOT NULL"
    )
    version_num, has_core_uuid = cur.fetchone()
    if version_num < 130000 or not has_core_uuid:
        cur.execute(sql)
        return False

    adjusted = PGCRYPTO_EXTENSION_DDL.sub(
        "-- Probe compatibility: pgcrypto install omitted; core gen_random_uuid() is available.",
        sql,
    )
    cur.execute(adjusted)
    return True


def report_candidate_markers(conn: psycopg.Connection) -> None:
    """Print selected post-chain schema/data markers for candidate comparison."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name || ':' || data_type ||
                   CASE WHEN is_nullable = 'NO' THEN ':not-null' ELSE '' END
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'admin_profiles'
            ORDER BY ordinal_position
            """
        )
        profile_columns = [row[0] for row in cur.fetchall()]
        cur.execute(
            """
            SELECT pg_get_constraintdef(oid)
            FROM pg_constraint
            WHERE conrelid = 'public.admin_profiles'::regclass AND contype = 'p'
            """
        )
        profile_pk = cur.fetchone()
        cur.execute(
            """
            SELECT t.typname, e.enumlabel
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            JOIN pg_enum e ON e.enumtypid = t.oid
            WHERE n.nspname = 'public' AND t.typname IN ('app_role', 'receipt_job_status')
            ORDER BY t.typname, e.enumsortorder
            """
        )
        enum_rows = cur.fetchall()
        cur.execute(
            """
            SELECT count(*),
                   count(*) FILTER (WHERE lot_number ~ '^[0-9]+$'),
                   count(*) FILTER (WHERE lot_number ~* '^LOT-[0-9]+$'),
                   count(DISTINCT base_price)
            FROM public.parcels
            """
        )
        parcel_summary = cur.fetchone()

    print("Candidate comparison markers after all tracked migrations:")
    print(f"  admin_profiles columns: {', '.join(profile_columns)}")
    print(f"  admin_profiles primary key: {profile_pk[0] if profile_pk else '(none)'}")
    enum_summary: dict[str, list[str]] = {}
    for type_name, label in enum_rows:
        enum_summary.setdefault(type_name, []).append(label)
    for type_name, labels in sorted(enum_summary.items()):
        print(f"  {type_name}: {', '.join(labels)}")
    if parcel_summary:
        total, numeric_ids, legacy_prefixed_ids, distinct_prices = parcel_summary
        print(
            "  parcels: "
            f"{total} total; {numeric_ids} numeric lot numbers; "
            f"{legacy_prefixed_ids} LOT-numbered; {distinct_prices} distinct base prices"
        )
    print("  Parcel rows are legacy synthetic data, not Hopkins/register evidence.")


def normalize_public_schema_dump(sql: str) -> str:
    """Remove only pg_dump's volatile header and psql restrict tokens."""
    stable_lines = []
    for line in sql.splitlines():
        if line.startswith(("-- Started on ", "-- Dumped on ", "-- Dumped by pg_dump version ", "-- Dumped from database version ")):
            continue
        if line.startswith(("\\restrict ", "\\unrestrict ")):
            continue
        stable_lines.append(line.rstrip())
    return "\n".join(stable_lines).strip() + "\n"


def public_schema_objects(sql: str) -> dict[str, str]:
    """Split normalized pg_dump output into named public catalog objects."""
    headers = list(PUBLIC_DUMP_OBJECT_HEADER.finditer(sql))
    if not headers:
        return {"SCHEMA PREAMBLE": sql}

    objects: dict[str, str] = {}
    preamble = sql[:headers[0].start()].strip()
    if preamble:
        objects["SCHEMA PREAMBLE"] = preamble
    for index, header in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(sql)
        name, object_type = header.groups()
        key = f"{object_type}: {name}"
        objects[key] = sql[header.start():end].strip()
    return objects


def compare_candidate_schemas(diff_lines: int) -> int:
    """Run each candidate in a disposable child process and diff public DDL."""
    if diff_lines < 0:
        print("error: --diff-lines must be non-negative", file=sys.stderr)
        return 2
    dumps: dict[str, str] = {}
    for candidate_name in FOUNDATION_CANDIDATES:
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--baseline",
            candidate_name,
            "--emit-public-schema",
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
        except Exception as exc:
            print(f"error: could not run {candidate_name} candidate probe: {exc}", file=sys.stderr)
            return 2
        if result.returncode != 0:
            print(f"error: {candidate_name} candidate probe failed with exit {result.returncode}", file=sys.stderr)
            print(result.stdout, file=sys.stderr)
            print(result.stderr, file=sys.stderr)
            return result.returncode or 2

        begin = "--- BEGIN PUBLIC SCHEMA ---\n"
        end = "\n--- END PUBLIC SCHEMA ---"
        start_at = result.stdout.find(begin)
        end_at = result.stdout.find(end, start_at + len(begin)) if start_at >= 0 else -1
        if start_at < 0 or end_at < 0:
            print(f"error: {candidate_name} candidate probe did not emit a schema dump", file=sys.stderr)
            return 2
        dumps[candidate_name] = normalize_public_schema_dump(
            result.stdout[start_at + len(begin):end_at]
        )

        print(f"{candidate_name} candidate:")
        for line in result.stdout.splitlines():
            if line.startswith((
                "PASS: all ",
                "  admin_profiles columns:",
                "  admin_profiles primary key:",
                "  app_role:",
                "  receipt_job_status:",
                "  parcels:",
            )):
                print(f"  {line.strip()}")
        print("  Parcel rows are synthetic legacy fixtures, not Hopkins/register evidence.")

    archive_dump = dumps["archive"]
    root_dump = dumps["root"]
    archive_hash = hashlib.sha256(archive_dump.encode("utf-8")).hexdigest()
    root_hash = hashlib.sha256(root_dump.encode("utf-8")).hexdigest()
    print("Post-chain public-schema DDL comparison (pg_dump --schema-only --schema=public --no-owner):")
    print(f"  archive: {len(archive_dump.encode('utf-8'))} bytes, sha256 {archive_hash}")
    print(f"  root:    {len(root_dump.encode('utf-8'))} bytes, sha256 {root_hash}")
    if archive_dump == root_dump:
        print("  result: identical public schema DDL (ownership excluded; ACLs included)")
        return 0

    diff = list(difflib.unified_diff(
        archive_dump.splitlines(),
        root_dump.splitlines(),
        fromfile="archive-foundation + tracked migrations",
        tofile="root-foundation + tracked migrations",
        n=1,
        lineterm="",
    ))
    added = sum(line.startswith("+") and not line.startswith("+++") for line in diff)
    removed = sum(line.startswith("-") and not line.startswith("---") for line in diff)
    print(f"  result: DIFFERENT ({removed} archive-only and {added} root-only DDL lines)")
    archive_objects = public_schema_objects(archive_dump)
    root_objects = public_schema_objects(root_dump)
    archive_keys = set(archive_objects)
    root_keys = set(root_objects)
    archive_only = sorted(archive_keys - root_keys)
    root_only = sorted(root_keys - archive_keys)
    changed = sorted(
        key for key in archive_keys & root_keys
        if archive_objects[key] != root_objects[key]
    )
    print(
        "  catalog objects: "
        f"{len(archive_only)} archive-only, {len(root_only)} root-only, {len(changed)} changed in both"
    )
    for label, names in (("archive-only", archive_only), ("root-only", root_only), ("changed", changed)):
        if names:
            shown_names = names[:120]
            print(f"    {label}: {', '.join(shown_names)}")
            if len(names) > len(shown_names):
                print(f"      ... {len(names) - len(shown_names)} more")
    shown = diff[:diff_lines]
    print("\n".join(shown))
    if len(diff) > len(shown):
        print(f"... {len(diff) - len(shown)} diff lines omitted; rerun with --diff-lines {len(diff)} for the full comparison")
    return 0


def main() -> int:
    args = parse_args()
    if args.compare_candidates:
        return compare_candidate_schemas(args.diff_lines)
    migration_files = sorted(MIGRATIONS.glob("*.sql"))
    if not migration_files:
        print(f"error: no tracked migrations found in {MIGRATIONS}", file=sys.stderr)
        return 2

    print("Scope: disposable embedded PostgreSQL; no linked/hosted project is contacted.")
    if args.baseline == "none":
        print("Starting without an app-schema baseline; this is not Supabase db reset.")
    else:
        candidate = FOUNDATION_CANDIDATES[args.baseline]
        if not candidate.is_file():
            print(f"error: selected foundation candidate is missing: {candidate}", file=sys.stderr)
            return 2
        print(f"Experimental foundation candidate: {candidate.relative_to(ROOT)}")
        print("Only minimal Auth/Storage SQL stubs are installed; this is not Supabase db reset.")
    print(f"Tracked migrations: {len(migration_files)}")

    if args.baseline != "none":
        candidate = FOUNDATION_CANDIDATES[args.baseline]
        unsupported_apis = sorted({
            match.group(1).lower()
            for path in (candidate, *migration_files)
            for match in NON_CORE_PGCRYPTO_API.finditer(path.read_text(encoding="utf-8"))
        })
        if unsupported_apis:
            print(
                "error: candidate replay uses pgcrypto APIs this embedded probe "
                f"cannot emulate: {', '.join(unsupported_apis)}",
                file=sys.stderr,
            )
            return 2
    elif args.emit_public_schema:
        print("error: --emit-public-schema requires a named candidate baseline", file=sys.stderr)
        return 2

    try:
        with tempfile.TemporaryDirectory(prefix="wamule-migration-probe-") as temp_root:
            pgdata = Path(temp_root) / "pgdata"
            with pgserver.get_server(pgdata, cleanup_mode="delete") as server:
                with psycopg.connect(server.get_uri("postgres"), autocommit=True) as conn:
                    install_platform_stubs(conn)
                    pgcrypto_skipped = 0

                    if args.baseline != "none":
                        candidate = FOUNDATION_CANDIDATES[args.baseline]
                        try:
                            with conn.cursor() as cur:
                                pgcrypto_skipped += execute_repository_sql(
                                    cur, candidate.read_text(encoding="utf-8")
                                )
                        except Exception as exc:
                            conn.rollback()
                            detail = " ".join(str(exc).split())
                            print(f"BASELINE BLOCKED: {candidate.relative_to(ROOT)}")
                            print(f"First database error: {detail[:700]}")
                            return 1
                        print(f"ok - candidate baseline {candidate.relative_to(ROOT)}")

                    applied = 0
                    for migration_path in migration_files:
                        try:
                            with conn.cursor() as cur:
                                pgcrypto_skipped += execute_repository_sql(
                                    cur, migration_path.read_text(encoding="utf-8")
                                )
                        except Exception as exc:
                            conn.rollback()
                            detail = " ".join(str(exc).split())
                            print(f"BLOCKED: {migration_path.name}")
                            print(f"Applied before blocker: {applied}/{len(migration_files)}")
                            print(f"First database error: {detail[:700]}")
                            return 1
                        applied += 1
                        print(f"ok - {migration_path.name}")
                    if pgcrypto_skipped:
                        print(
                            f"Compatibility note: skipped {pgcrypto_skipped} pgcrypto install statement(s); "
                            "only core gen_random_uuid() usage was exercised."
                        )
                    if args.baseline != "none":
                        report_candidate_markers(conn)
                    if args.emit_public_schema:
                        dump_command = [
                            str(POSTGRES_BIN_PATH / "pg_dump"),
                            "--schema-only",
                            "--schema=public",
                            "--no-owner",
                            server.get_uri("postgres"),
                        ]
                        dump = subprocess.run(
                            dump_command,
                            capture_output=True,
                            text=True,
                            timeout=60,
                            check=False,
                        )
                        if dump.returncode != 0:
                            print(f"error: pg_dump failed: {dump.stderr.strip()}", file=sys.stderr)
                            return 2
                        print("--- BEGIN PUBLIC SCHEMA ---")
                        print(dump.stdout, end="")
                        print("--- END PUBLIC SCHEMA ---")

    except Exception as exc:
        print(f"error: bootstrap probe could not run: {exc}", file=sys.stderr)
        return 2

    print(f"PASS: all {len(migration_files)} tracked migrations applied in order.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
