"""
app.auth
--------
A single shared-secret check (X-API-Key header) — this bridge can place
real orders once trading is enabled, so it must never be reachable
without one, even on localhost. CORS in main.py is permissive so the
browser can call this directly; this check is the actual access control,
not CORS.
"""
from __future__ import annotations

import hmac

from fastapi import Header, HTTPException  # type: ignore[import-not-found]

from .config import Settings


def require_api_key(settings: Settings):
    def _check(x_api_key: str | None = Header(default=None)) -> None:
        if x_api_key is None or not hmac.compare_digest(x_api_key, settings.api_key):
            raise HTTPException(status_code=401, detail="Missing or invalid X-API-Key header.")

    return _check
