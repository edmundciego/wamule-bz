#!/usr/bin/env python3
"""Read one value from `supabase status --output env` without echoing others."""
from __future__ import annotations

import shlex
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: read-supabase-status-env.py <env-file> <variable>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    wanted = sys.argv[2]
    if not wanted.isidentifier() or not path.is_file():
        print("Invalid status variable or missing status file.", file=sys.stderr)
        return 2
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, raw_value = stripped.split("=", 1)
        if not key.isidentifier():
            continue
        parsed = shlex.split(raw_value, posix=True)
        if len(parsed) != 1:
            continue
        values[key] = parsed[0]
    value = values.get(wanted)
    if not value:
        print(f"Supabase status did not provide {wanted}.", file=sys.stderr)
        return 1
    sys.stdout.write(value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
