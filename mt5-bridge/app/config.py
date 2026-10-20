"""
app.config
----------
Everything the bridge needs comes from environment variables (loaded from
a local .env via python-dotenv), never hardcoded — the MT5 account
password and the bridge's own API key are secrets and must not end up in
source control. See .env.example for the full list with explanations.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    mt5_login: int
    mt5_password: str
    mt5_server: str
    mt5_terminal_path: str | None
    api_key: str
    allow_trading: bool
    host: str
    port: int


def load_settings() -> Settings:
    login_raw = os.environ.get("MT5_LOGIN")
    password = os.environ.get("MT5_PASSWORD")
    server = os.environ.get("MT5_SERVER")
    if not login_raw or not password or not server:
        raise RuntimeError(
            "MT5_LOGIN, MT5_PASSWORD, and MT5_SERVER must all be set. "
            "Copy .env.example to .env and fill them in."
        )

    api_key = os.environ.get("MT5_BRIDGE_API_KEY")
    if not api_key or api_key == "change-me":
        raise RuntimeError(
            "MT5_BRIDGE_API_KEY must be set to a real secret (not the .env.example "
            "placeholder) — this bridge should never run without a real access key, "
            "since it's an HTTP service that can place real orders once trading is enabled."
        )

    try:
        login = int(login_raw)
    except ValueError as exc:
        raise RuntimeError(f"MT5_LOGIN must be numeric, got: {login_raw!r}") from exc

    return Settings(
        mt5_login=login,
        mt5_password=password,
        mt5_server=server,
        mt5_terminal_path=os.environ.get("MT5_TERMINAL_PATH") or None,
        api_key=api_key,
        allow_trading=os.environ.get("MT5_BRIDGE_ALLOW_TRADING", "false").strip().lower() == "true",
        host=os.environ.get("MT5_BRIDGE_HOST", "127.0.0.1"),
        port=int(os.environ.get("MT5_BRIDGE_PORT", "8787")),
    )
