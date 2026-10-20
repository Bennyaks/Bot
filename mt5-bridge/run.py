"""
Entrypoint: `python run.py`

(Equivalent to `uvicorn app.main:app --host <MT5_BRIDGE_HOST> --port <MT5_BRIDGE_PORT>`
directly, if you'd rather run uvicorn yourself — e.g. to add --reload during
development. This script exists so the host/port come from the same .env
as everything else instead of being typed twice.)
"""
from __future__ import annotations

import uvicorn

from app.config import load_settings

if __name__ == "__main__":
    settings = load_settings()
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)
