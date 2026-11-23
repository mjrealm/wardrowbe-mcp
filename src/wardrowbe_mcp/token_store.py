"""Keeps the newest OIDC refresh token on disk, so a restart does not need a new login."""

from __future__ import annotations

import json
import os
from pathlib import Path


class TokenStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self, issuer_url: str, client_id: str) -> str | None:
        """Returns the saved token for this issuer and client, or None."""
        try:
            entry = json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return None
        except (ValueError, OSError):
            return None  # A corrupt file counts as missing. The next sign-in overwrites it.
        if not isinstance(entry, dict):
            return None
        if entry.get("issuerUrl") != issuer_url or entry.get("clientId") != client_id:
            return None
        return entry.get("refreshToken") or None

    def save(self, issuer_url: str, client_id: str, refresh_token: str) -> None:
        """Writes atomically with owner-only permissions."""
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = self.path.with_name(self.path.name + ".tmp")
        payload = json.dumps(
            {"issuerUrl": issuer_url, "clientId": client_id, "refreshToken": refresh_token}, indent=2
        )
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload + "\n")
        os.replace(tmp, self.path)
