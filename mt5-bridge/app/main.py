"""
MT5 Bridge
----------
A small local HTTP service that exposes a running MetaTrader 5 terminal —
candles, spread, account equity, open positions, order submit/close — to
the Analysis Engine app, so a real `MT5MarketProvider`/`MT5Broker` on the
JS side can call this instead of the simulated `ReplayMarketProvider`/
`PaperBroker`.

Run this ONLY on the Windows machine with the MT5 terminal installed and
logged into your account — see README.md for full setup. This service
does not run on Linux/Mac; the `MetaTrader5` package it depends on is
Windows-only (it talks to the terminal via local IPC).

Every endpoint except /health requires an `X-API-Key` header matching
MT5_BRIDGE_API_KEY (see app/auth.py). Order endpoints additionally refuse
to do anything unless MT5_BRIDGE_ALLOW_TRADING=true (see app/mt5_client.py)
— verify /account, /candles, and /spread look correct before ever setting
that.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import TypeVar

from fastapi import Depends, FastAPI, Query
from starlette.middleware.cors import CORSMiddleware

from .auth import require_api_key
from .config import load_settings
from .mt5_client import MT5Client, MT5ConnectionError, MT5OrderError
from .models import (
    AccountOut,
    CandleOut,
    CloseOut,
    CloseRequest,
    HealthOut,
    OrderOut,
    OrderRequest,
    PositionOut,
    SpreadOut,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("mt5-bridge")

settings = load_settings()
client = MT5Client(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info("Connecting to MT5 terminal (login=%s, server=%s)...", settings.mt5_login, settings.mt5_server)
    # Fail loudly at startup rather than serving a half-working API — every
    # route below assumes a live connection and would just 503 anyway, so
    # there's no benefit to "starting successfully" without one.
    client.connect()
    logger.info("Connected. Trading is %s.", "ENABLED" if settings.allow_trading else "DISABLED (read-only)")
    yield
    client.disconnect()
    logger.info("Disconnected from MT5 terminal.")


app = FastAPI(title="MT5 Bridge", version="1.0.0", lifespan=lifespan)

# Permissive CORS is fine here specifically because X-API-Key (not origin)
# is the real access control — see app/auth.py.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

authed = Depends(require_api_key(settings))

T = TypeVar("T")


def call(fn: Callable[[], T]) -> T:
    """Runs an MT5Client call and turns its two error types into the right HTTP status — every route below is a one-liner around this instead of repeating the same try/except."""
    from fastapi import HTTPException

    try:
        return fn()
    except MT5ConnectionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except MT5OrderError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    # Deliberately not behind auth — a caller needs to be able to check
    # "is this bridge even up" before it has anything else to authenticate.
    return HealthOut(connected=client.is_connected(), tradingEnabled=settings.allow_trading)


@app.get("/account", response_model=AccountOut, dependencies=[authed])
def account() -> AccountOut:
    return AccountOut(**call(client.account_summary))


@app.get("/spread", response_model=SpreadOut, dependencies=[authed])
def spread(symbol: str = Query(...)) -> SpreadOut:
    value = call(lambda: client.get_spread(symbol))
    return SpreadOut(symbol=symbol, spread=value)


@app.get("/candles", response_model=list[CandleOut], dependencies=[authed])
def candles(
    symbol: str = Query(...),
    timeframe: str = Query("15m"),
    count: int = Query(150, gt=0, le=5000),
) -> list[CandleOut]:
    rows = call(lambda: client.get_candles(symbol, timeframe, count))
    return [CandleOut(time=r.time, open=r.open, high=r.high, low=r.low, close=r.close, volume=r.volume) for r in rows]


@app.get("/positions", response_model=list[PositionOut], dependencies=[authed])
def positions() -> list[PositionOut]:
    rows = call(client.list_open_positions)
    return [PositionOut(**r) for r in rows]


@app.post("/orders", response_model=OrderOut, dependencies=[authed])
def submit_order(body: OrderRequest) -> OrderOut:
    result = call(lambda: client.submit_order(body.symbol, body.side, body.volume, body.stop, body.target))
    return OrderOut(**result)


@app.post("/orders/close", response_model=CloseOut, dependencies=[authed])
def close_order(body: CloseRequest) -> CloseOut:
    result = call(lambda: client.close_position(body.ticket, body.symbol, body.side, body.volume))
    return CloseOut(**result)
