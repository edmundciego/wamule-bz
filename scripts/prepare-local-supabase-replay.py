#!/usr/bin/env python3
"""Build an isolated Supabase CLI workdir from the reconciled staging ledger.

This helper only copies reviewed migration sources into an explicit temporary
project. It never links to, authenticates with, or queries hosted Supabase.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
STAGING_REF = "kvocwmrcuhiaezlcgzjf"
PG_MAJOR = 17
HOPKINS_PHASE_GATE = ROOT / "supabase/migrations/20261111030739_initial_phase_application_allowlist.sql"
HOPKINS_PHASE_GATE_SHA256 = "3faf71cd8ce96fef584998ba083f895024f7699a2edeedc8e59aa57aad468235"
M1_5_OVERLAY = ROOT / "supabase/staging-migrations/20261105000100_harden_sensitive_view_access.sql"
M1_5_SHA256 = "d16b6fba02cb210e9e628f5cf11c555f74db7e18fbe6afe663150158cb72d631"
FOUNDATION_BASELINE = ROOT / "wamuale_supabase_foundation_migration.sql"
FOUNDATION_BASELINE_SHA256 = "5671fe8bfb5e0fcd6318f92dc0147367ffb543234d7d8cc6d2bc0f8eaa3d265a"
HOPKINS_WORKFLOW_FIXTURE = ROOT / "scripts/replay-fixtures/hopkins-workflow-precondition.sql"
HOPKINS_WORKFLOW_FIXTURE_SHA256 = "7d44c34ccfa421e0b23a4ddce5b16448fb6366103a7c11834d694c7967fcc3bc"
HOPKINS_WORKFLOW_FIXTURE_BEFORE = "20261016054341"
M81_MANIFEST = ROOT / "evidence/M8.1-staging-source-manifest-2026-11-08.json"
CAPTURED_69_INVENTORY = ROOT / "evidence/hopkins-initial-staging-replay-migration-inventory-2026-11-11.json"
MAP_STUDIO_LEDGER_VERSION = "20261019225217"
MAP_STUDIO_SOURCE = "supabase/migrations/20261019194346_map_studio_packages_and_project_plot_content.sql"
MAP_STUDIO_SOURCE_SHA256 = "86766d43a0335a046e2224fdbb43c78f66ac02df91230f803b7959d56ec775f5"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_replay_builder():
    path = ROOT / "scripts/replay-staging-migration-ledger.py"
    spec = importlib.util.spec_from_file_location("replay_staging_migration_ledger", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the M2.4 ledger reconciler.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def build(output: Path) -> dict:
    if output.exists() and any(output.iterdir()):
        raise RuntimeError(f"Output directory is not empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    supabase_dir = output / "supabase"
    migrations_dir = supabase_dir / "migrations"
    migrations_dir.mkdir(parents=True, exist_ok=True)

    reconciler = load_replay_builder()
    baseline_files, _ = reconciler.create_replay_migrations(migrations_dir)
    alias_rows = [entry for entry in baseline_files if entry["version"] == MAP_STUDIO_LEDGER_VERSION]
    if len(alias_rows) != 1 or alias_rows[0]["source"] != MAP_STUDIO_SOURCE:
        raise RuntimeError("The captured Map Studio migration alias must be replayed exactly once under applied version 20261019225217.")
    alias_path = migrations_dir / f"{MAP_STUDIO_LEDGER_VERSION}_map_studio_packages_and_project_plot_content.sql"
    if not alias_path.is_file() or sha256(alias_path) != MAP_STUDIO_SOURCE_SHA256:
        raise RuntimeError("The Map Studio migration body differs from the captured applied staging body hash.")
    if any(entry["version"] == "20261019194346" for entry in baseline_files):
        raise RuntimeError("The Map Studio source timestamp must not be replayed separately from its applied ledger alias.")
    entries: list[dict[str, str]] = []
    for entry in baseline_files:
        path = migrations_dir / f"{entry['version']}_{entry['name']}.sql"
        entries.append({"version": entry["version"], "path": str(path.relative_to(output)), "sha256": sha256(path), "source": entry["source"]})

    release = json.loads(M81_MANIFEST.read_text(encoding="utf-8"))
    file_manifest = {row["path"]: row for row in release["release_content"]["files"]}
    forward_sources = release["migration_sequence"]["forward_migrations_after_that_ledger"]
    if len(baseline_files) != 55 or len(forward_sources) != 13:
        raise RuntimeError("M2.4/M8.1 migration counts changed; review the reconciliation evidence.")
    for source_relative in forward_sources:
        source = ROOT / source_relative
        expected = file_manifest.get(source_relative)
        if expected is None or expected.get("category") != "forward-migration":
            raise RuntimeError(f"Forward migration is absent from the M8.1 manifest: {source_relative}")
        if sha256(source) != expected["sha256"]:
            raise RuntimeError(f"Forward migration differs from the reviewed M8.1 hash: {source_relative}")
        target = migrations_dir / source.name
        shutil.copy2(source, target)
        entries.append({"version": source.name.split("_", 1)[0], "path": str(target.relative_to(output)), "sha256": sha256(target), "source": source_relative})

    if not HOPKINS_PHASE_GATE.is_file() or sha256(HOPKINS_PHASE_GATE) != HOPKINS_PHASE_GATE_SHA256:
        raise RuntimeError("The deployed Hopkins Initial phase-gate migration does not match its recorded hash.")
    shutil.copy2(HOPKINS_PHASE_GATE, migrations_dir / HOPKINS_PHASE_GATE.name)
    entries.append({"version": HOPKINS_PHASE_GATE.name.split("_", 1)[0], "path": f"supabase/migrations/{HOPKINS_PHASE_GATE.name}", "sha256": HOPKINS_PHASE_GATE_SHA256, "source": str(HOPKINS_PHASE_GATE.relative_to(ROOT))})

    versions = [entry["version"] for entry in entries]
    if len(entries) != 69 or len(set(versions)) != len(versions) or versions != sorted(versions):
        raise RuntimeError("The expected 69-entry staging migration sequence is not unique and chronological.")
    captured = json.loads(CAPTURED_69_INVENTORY.read_text(encoding="utf-8"))
    captured_rows = captured.get("files", [])
    expected_order = [(row["version"], row["name"]) for row in captured_rows]
    actual_order = []
    for entry in entries:
        filename = Path(entry["path"]).name
        version, name = filename.split("_", 1)
        actual_order.append((version, name))
    if captured.get("target_project_ref") != STAGING_REF or len(captured_rows) != 69:
        raise RuntimeError("The captured staging migration inventory no longer identifies the expected 69-entry staging ledger.")
    if actual_order != expected_order:
        first = next((index for index, pair in enumerate(zip(actual_order, expected_order), start=1) if pair[0] != pair[1]), None)
        raise RuntimeError(f"The prepared migration order differs from the captured 69-entry staging ledger at position {first}.")
    captured_alias = [row for row in captured_rows if row["version"] == MAP_STUDIO_LEDGER_VERSION]
    if len(captured_alias) != 1 or captured_alias[0]["sha256"] != MAP_STUDIO_SOURCE_SHA256:
        raise RuntimeError("The captured applied Map Studio alias/hash is absent or ambiguous.")
    if not M1_5_OVERLAY.is_file() or sha256(M1_5_OVERLAY) != M1_5_SHA256:
        raise RuntimeError("The separately applied M1.5 view overlay does not match its recorded hash.")
    overlay_dir = supabase_dir / "local-overlays"
    overlay_dir.mkdir()
    shutil.copy2(M1_5_OVERLAY, overlay_dir / M1_5_OVERLAY.name)

    if not HOPKINS_WORKFLOW_FIXTURE.is_file() or sha256(HOPKINS_WORKFLOW_FIXTURE) != HOPKINS_WORKFLOW_FIXTURE_SHA256:
        raise RuntimeError("The local Hopkins workflow precondition fixture differs from its reviewed hash.")
    fixture_target = supabase_dir / "replay-fixtures" / HOPKINS_WORKFLOW_FIXTURE.name
    fixture_target.parent.mkdir()
    shutil.copy2(HOPKINS_WORKFLOW_FIXTURE, fixture_target)
    local_data_preconditions = [{
        "before_migration": HOPKINS_WORKFLOW_FIXTURE_BEFORE,
        "path": str(fixture_target.relative_to(output)),
        "sha256": HOPKINS_WORKFLOW_FIXTURE_SHA256,
        "included_in_migration_count": False,
        "purpose": "Synthetic active Hopkins tenant/project/initial phase required by migration 20261016054341.",
    }]

    source_config = ROOT / "supabase/config.toml"
    config = source_config.read_text(encoding="utf-8")
    config = re.sub(r'(?m)^project_id\s*=\s*"[^"]+"\s*$', 'project_id = "wamule-local-replay"', config, count=1)
    if f'project_id = "wamule-local-replay"' not in config:
        raise RuntimeError("Could not replace the linked project ID in the temporary config.")
    if not re.search(r"(?m)^\[db\]\s*$", config):
        config = config.replace('\n# Public embed endpoints:', '\n[db]\nmajor_version = 17\n\n# Public embed endpoints:', 1)
    else:
        config = re.sub(r"(?m)^major_version\s*=.*$", "major_version = 17", config, count=1)
    (supabase_dir / "config.toml").write_text(config, encoding="utf-8")

    if not FOUNDATION_BASELINE.is_file() or sha256(FOUNDATION_BASELINE) != FOUNDATION_BASELINE_SHA256:
        raise RuntimeError("The M2.4 reconciled foundation schema bootstrap is missing or its reviewed hash changed.")
    foundation_target = supabase_dir / "foundation.sql"
    shutil.copy2(FOUNDATION_BASELINE, foundation_target)

    functions_target = supabase_dir / "functions"
    functions_source = ROOT / "supabase/functions"
    functions_target.symlink_to(functions_source, target_is_directory=True)

    manifest = {
        "target_kind": "local-only Supabase CLI project",
        "hosted_project_ref_used": False,
        "postgres_major_version": PG_MAJOR,
        "foundation_schema_bootstrap": {
            "path": str(foundation_target.relative_to(output)),
            "sha256": FOUNDATION_BASELINE_SHA256,
            "included_in_migration_count": False,
        },
        "m2_4_captured_migrations": 55,
        "m8_1_forward_migrations": 13,
        "hopkins_phase_gate_migration": HOPKINS_PHASE_GATE.name,
        "numbered_migration_count": len(entries),
        "captured_ledger_comparison": {
            "evidence": str(CAPTURED_69_INVENTORY.relative_to(ROOT)),
            "ordered_version_name_match": True,
            "captured_entry_count": len(captured_rows),
        },
        "map_studio_alias": {
            "applied_version": MAP_STUDIO_LEDGER_VERSION,
            "source_version": "20261019194346",
            "source_path": MAP_STUDIO_SOURCE,
            "sha256": MAP_STUDIO_SOURCE_SHA256,
            "included_exactly_once": True,
        },
        "m1_5_separate_overlay": {"path": str((overlay_dir / M1_5_OVERLAY.name).relative_to(output)), "sha256": M1_5_SHA256, "included_in_numbered_ledger": False},
        "excluded_local_only_migrations": ["20261110090000_audit_default_phase_before_after.sql"],
        "local_data_preconditions": local_data_preconditions,
        "migrations": entries,
    }
    (output / "replay-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path, help="Empty temporary project directory")
    args = parser.parse_args()
    try:
        output = args.out.resolve()
        manifest = build(output)
    except Exception as error:
        print(f"[local-supabase-replay] FAIL: {error}", file=sys.stderr)
        return 2
    print(json.dumps({key: value for key, value in manifest.items() if key != "migrations"}, indent=2))
    print(f"[local-supabase-replay] prepared foundation bootstrap plus {manifest['numbered_migration_count']} migrations; no hosted connection was used.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
