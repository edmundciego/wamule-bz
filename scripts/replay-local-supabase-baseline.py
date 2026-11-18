#!/usr/bin/env python3
"""Apply the reviewed foundation and exact migration manifest to a local Supabase Postgres."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


FOUNDATION_SHA256 = "5671fe8bfb5e0fcd6318f92dc0147367ffb543234d7d8cc6d2bc0f8eaa3d265a"
EXPECTED_MIGRATION_COUNT = 73
EXCLUDED_COMPATIBILITY_VERSION = "20261112040000"
VERSION_RE = re.compile(r"^\d{14}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_error(stderr: str) -> str:
    text = re.sub(r"\b(?:postgres(?:ql)?|https?)://[^\s\"'<>]+", "[DATABASE URL REDACTED]", stderr, flags=re.I)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b", "[JWT REDACTED]", text)
    return "\n".join(text.splitlines()[-30:])


def run_psql(database_url: str, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["psql", database_url, "-X", "-q", "-v", "ON_ERROR_STOP=1", *args],
        text=True,
        capture_output=True,
        check=False,
    )


def write_state(path: Path, state: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()

    database_url = os.environ.get("SCHEMA_QUERY_DATABASE_URL", "")
    if not database_url:
        print("[local-postgres-replay] SCHEMA_QUERY_DATABASE_URL is required.", file=sys.stderr)
        return 2
    parsed = urlsplit(database_url)
    if parsed.scheme not in {"postgres", "postgresql"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        print("[local-postgres-replay] Refusing non-local PostgreSQL target.", file=sys.stderr)
        return 2

    manifest_path = args.manifest.resolve()
    root = manifest_path.parent
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("target_kind") != "local-only Supabase CLI project" or manifest.get("hosted_project_ref_used") is not False:
        print("[local-postgres-replay] Manifest is not marked local-only.", file=sys.stderr)
        return 2
    migrations = manifest.get("migrations", [])
    versions = [entry.get("version", "") for entry in migrations]
    if len(migrations) != EXPECTED_MIGRATION_COUNT or len(set(versions)) != EXPECTED_MIGRATION_COUNT or versions != sorted(versions):
        print("[local-postgres-replay] Expected 73 unique migrations in ascending version order.", file=sys.stderr)
        return 2
    inventory_info = manifest.get("staging_inventory", {})
    inventory_path = (root / inventory_info.get("path", "")).resolve()
    if (manifest.get("inventory_entry_count") != EXPECTED_MIGRATION_COUNT
            or inventory_info.get("ordered_version_filename_sha256_match") is not True
            or root not in inventory_path.parents or not inventory_path.is_file()):
        print("[local-postgres-replay] Manifest does not contain a validated 73-entry source inventory.", file=sys.stderr)
        return 2
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    inventory_rows = inventory.get("files", [])
    migration_rows = [{
        "version": entry.get("version", ""),
        "name": Path(entry.get("path", "")).name.split("_", 1)[-1],
        "sha256": entry.get("sha256", ""),
    } for entry in migrations]
    if len(inventory_rows) != EXPECTED_MIGRATION_COUNT or inventory_rows != migration_rows:
        print("[local-postgres-replay] Version, filename, or SHA-256 differs from the complete ordered 73-entry inventory.", file=sys.stderr)
        return 2
    if EXCLUDED_COMPATIBILITY_VERSION in versions or inventory_info.get("broad_compatibility_migration_excluded") != EXCLUDED_COMPATIBILITY_VERSION:
        print("[local-postgres-replay] Broad 20261112040000 compatibility migration must remain excluded.", file=sys.stderr)
        return 2

    overlay = manifest.get("m1_5_separate_overlay", {})
    overlay_path = (root / overlay.get("path", "")).resolve()
    overlay_after_version = overlay.get("apply_after_version", "")
    overlay_filename = overlay_path.name
    if (overlay.get("included_in_numbered_ledger") is not False
            or overlay.get("sha256") != "d16b6fba02cb210e9e628f5cf11c555f74db7e18fbe6afe663150158cb72d631"
            or overlay_after_version not in versions
            or root not in overlay_path.parents or not overlay_path.is_file()
            or digest(overlay_path) != overlay.get("sha256")
            or overlay_filename != "20261105000100_harden_sensitive_view_access.sql"):
        print("[local-postgres-replay] Separate M1.5 overlay path, position, or SHA-256 is invalid.", file=sys.stderr)
        return 2
    overlay_index = versions.index(overlay_after_version)
    if overlay_after_version != "20261112033403" or versions[overlay_index + 1:overlay_index + 2] != ["20261112033404"]:
        print("[local-postgres-replay] M1.5 must be separately applied after 20261112033403 and before 20261112033404.", file=sys.stderr)
        return 2

    preconditions = manifest.get("local_data_preconditions", [])
    preconditions_by_version: dict[str, list[tuple[dict, Path]]] = {}
    for item in preconditions:
        before_version = item.get("before_migration", "")
        relative_path, expected_hash = item.get("path", ""), item.get("sha256", "")
        path = (root / relative_path).resolve()
        if (before_version not in versions or item.get("included_in_migration_count") is not False
                or not VERSION_RE.fullmatch(before_version) or not SHA256_RE.fullmatch(expected_hash)
                or root not in path.parents or not path.is_file() or path.suffix != ".sql"
                or "migrations" in path.relative_to(root).parts or digest(path) != expected_hash):
            print(f"[local-postgres-replay] Local data precondition failed path/hash validation before {before_version or '[unknown]' }.", file=sys.stderr)
            return 2
        preconditions_by_version.setdefault(before_version, []).append((item, path))

    foundation = manifest.get("foundation_schema_bootstrap", {})
    foundation_path = (root / foundation.get("path", "")).resolve()
    if root not in foundation_path.parents or not foundation_path.is_file() or digest(foundation_path) != FOUNDATION_SHA256:
        print("[local-postgres-replay] Foundation bootstrap path or SHA-256 does not match the reviewed input.", file=sys.stderr)
        return 2
    if foundation.get("included_in_migration_count") is not False or foundation.get("sha256") != FOUNDATION_SHA256:
        print("[local-postgres-replay] Foundation must remain a separate, hash-pinned bootstrap.", file=sys.stderr)
        return 2

    prepared: list[tuple[dict, Path]] = []
    for entry in migrations:
        version, relative_path, expected_hash = entry.get("version", ""), entry.get("path", ""), entry.get("sha256", "")
        path = (root / relative_path).resolve()
        if (not VERSION_RE.fullmatch(version) or not NAME_RE.fullmatch(path.name.split("_", 1)[-1].removesuffix(".sql"))
                or not SHA256_RE.fullmatch(expected_hash) or root not in path.parents or not path.is_file()
                or digest(path) != expected_hash or path.suffix != ".sql"):
            print(f"[local-postgres-replay] Prepared migration input failed path/hash validation: {version}.", file=sys.stderr)
            return 2
        prepared.append((entry, path))

    server_version = run_psql(database_url, ["-t", "-A", "-c", "SHOW server_version_num;"])
    if server_version.returncode != 0:
        print("[local-postgres-replay] Could not read PostgreSQL server version.", file=sys.stderr)
        print(safe_error(server_version.stderr), file=sys.stderr)
        return 2
    try:
        server_version_num = int(server_version.stdout.strip())
    except ValueError:
        print("[local-postgres-replay] PostgreSQL returned an invalid server version.", file=sys.stderr)
        return 2
    if server_version_num // 10000 != 17:
        print(f"[local-postgres-replay] Expected PostgreSQL 17; found server_version_num={server_version_num}.", file=sys.stderr)
        return 2

    state_path = root / "applied-migrations.json"
    state = {
        "mode": "disposable-local-postgresql",
        "database_host": parsed.hostname,
        "server_version_num": server_version_num,
        "foundation_bootstrap": {"path": foundation["path"], "sha256": FOUNDATION_SHA256, "applied": False},
        "expected_migration_count": EXPECTED_MIGRATION_COUNT,
        "inventory_entry_count": EXPECTED_MIGRATION_COUNT,
        "applied_migration_count": 0,
        "applied_migrations": [],
        "m1_5_view_security_overlay": {
            "name": overlay_filename,
            "sha256": overlay["sha256"],
            "apply_after_version": overlay_after_version,
            "applied": False,
            "included_in_numbered_ledger": False,
        },
        "local_data_preconditions": [
            {"before_migration": item["before_migration"], "path": item["path"], "sha256": item["sha256"], "applied": False}
            for item in manifest.get("local_data_preconditions", [])
        ],
        "ordered_manifest_match": False,
    }
    write_state(state_path, state)

    result = run_psql(database_url, ["-f", str(foundation_path)])
    if result.returncode != 0:
        print("[local-postgres-replay] Foundation bootstrap failed.", file=sys.stderr)
        print(safe_error(result.stderr), file=sys.stderr)
        return 1
    type_result = run_psql(database_url, ["-t", "-A", "-c", "SELECT to_regtype('public.parcel_status') IS NOT NULL;"])
    if type_result.returncode != 0 or type_result.stdout.strip() != "t":
        print("[local-postgres-replay] Foundation bootstrap did not create public.parcel_status.", file=sys.stderr)
        print(safe_error(type_result.stderr), file=sys.stderr)
        return 1
    state["foundation_bootstrap"]["applied"] = True
    write_state(state_path, state)

    for position, (entry, path) in enumerate(prepared, start=1):
        for item, fixture_path in preconditions_by_version.get(entry["version"], []):
            result = run_psql(database_url, ["-f", str(fixture_path)])
            if result.returncode != 0:
                print(f"[local-postgres-replay] Local data precondition failed before migration {entry['version']} ({fixture_path.name}).", file=sys.stderr)
                print(safe_error(result.stderr), file=sys.stderr)
                return 1
            for state_item in state["local_data_preconditions"]:
                if state_item["before_migration"] == item["before_migration"] and state_item["sha256"] == item["sha256"]:
                    state_item["applied"] = True
                    break
            write_state(state_path, state)
            print(f"[local-postgres-replay] applied local-only data precondition before migration {entry['version']}; excluded from the numbered migration count.")
        result = run_psql(database_url, ["-f", str(path)])
        if result.returncode != 0:
            print(f"[local-postgres-replay] Failed migration {entry['version']} ({path.name}) at position {position}/{EXPECTED_MIGRATION_COUNT}.", file=sys.stderr)
            print(safe_error(result.stderr), file=sys.stderr)
            return 1
        state["applied_migrations"].append({
            "position": position,
            "version": entry["version"],
            "filename": path.name,
            "sha256": entry["sha256"],
        })
        state["applied_migration_count"] = position
        write_state(state_path, state)
        if entry["version"] == overlay_after_version:
            overlay_result = run_psql(database_url, ["-f", str(overlay_path)])
            if overlay_result.returncode != 0:
                print("[local-postgres-replay] Separate M1.5 security overlay failed after " + overlay_after_version + ".", file=sys.stderr)
                print(safe_error(overlay_result.stderr), file=sys.stderr)
                return 1
            state["m1_5_view_security_overlay"]["applied"] = True
            write_state(state_path, state)
            print(f"[local-postgres-replay] applied separate M1.5 overlay after {overlay_after_version}; excluded from the numbered migration count.")

    applied_versions = [entry["version"] for entry in state["applied_migrations"]]
    applied_rows = [{"version": entry["version"], "name": entry["filename"].split("_", 1)[-1], "sha256": entry["sha256"]} for entry in state["applied_migrations"]]
    state["ordered_manifest_match"] = applied_versions == versions and applied_rows == inventory_rows
    if (state["applied_migration_count"] != EXPECTED_MIGRATION_COUNT or not state["ordered_manifest_match"]
            or not state["m1_5_view_security_overlay"]["applied"]
            or any(not item["applied"] for item in state["local_data_preconditions"])):
        print("[local-postgres-replay] Final applied count/order or local fixture state did not match the manifest.", file=sys.stderr)
        return 1
    write_state(state_path, state)
    numbered_manifest = {
        "mode": "disposable-local-supabase-postgresql-17",
        "hosted_target_used": False,
        "schema_baseline_commit": os.environ.get("WAMULE_SCHEMA_BASE_COMMIT"),
        "tested_commit": os.environ.get("GITHUB_SHA"),
        "numbered_migration_count": EXPECTED_MIGRATION_COUNT,
        "inventory_entry_count": EXPECTED_MIGRATION_COUNT,
        "ordered_manifest_match": True,
        "separately_applied_overlay": {
            "name": overlay_filename,
            "sha256": overlay["sha256"],
            "apply_after_version": overlay_after_version,
            "included_in_numbered_ledger": False,
        },
        "migrations": state["applied_migrations"],
    }
    write_state(root / "numbered-migrations.json", numbered_manifest)
    print(json.dumps({key: value for key, value in state.items() if key != "applied_migrations"}, indent=2))
    print(f"[local-postgres-replay] applied {EXPECTED_MIGRATION_COUNT} migrations in exact inventory order plus separate M1.5 to disposable PostgreSQL {server_version_num}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
