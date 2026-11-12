#!/usr/bin/env python3
"""Redact credentials from local Supabase CLI failure excerpts for CI logs."""
from __future__ import annotations

import re
import sys
from pathlib import Path


JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
DATABASE_URL = re.compile(r"\b(?:postgres(?:ql)?|https?)://[^\s\"'<>]+", re.IGNORECASE)
KEY_VALUE = re.compile(
    r"(?i)\b((?:supabase[_ -])?(?:anon(?:ymous)?|service[_ -]?role|database|db|jwt|access[_ -]?token|refresh[_ -]?token)[ _-]?(?:key|token|secret|password|passphrase)\s*[:=])"
    r"\s*(?!\[(?:URL|JWT|CREDENTIAL) REDACTED\])[^\s,;]+"
)


def redact(text: str) -> str:
    text = DATABASE_URL.sub("[URL REDACTED]", text)
    text = JWT.sub("[JWT REDACTED]", text)
    return KEY_VALUE.sub(r"\1 [CREDENTIAL REDACTED]", text)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: redact-supabase-ci-log.py LOG_PATH", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    print(redact(path.read_text(encoding="utf-8", errors="replace")), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
