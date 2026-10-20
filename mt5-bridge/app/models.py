"""
app.models
----------
Response shapes deliberately mirror the TS-side types this bridge feeds —
CandleOut matches lib/types.ts's Candle, OrderOut/CloseOut match what
ExecutedTrade needs — so MT5MarketProvider/MT5Broker on the JS side can map
these onto existing interfaces with no field renaming.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class CandleOut(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class AccountOut(BaseModel):
    login: int
    server: str
    balance: float
    equity: float
    margin: float
    marginFree: float
    currency: str


class SpreadOut(BaseModel):
    symbol: str
    spread: float


class OrderRequest(BaseModel):
    symbol: str
    side: str = Field(pattern="^(LONG|SHORT)$")
    volume: float = Field(gt=0)
    stop: float
    target: float


class OrderOut(BaseModel):
    ticket: int
    price: float
    volume: float


class CloseRequest(BaseModel):
    ticket: int
    symbol: str
    side: str = Field(pattern="^(LONG|SHORT)$")
    volume: float = Field(gt=0)


class CloseOut(BaseModel):
    price: float
    volume: float


class PositionOut(BaseModel):
    ticket: int
    symbol: str
    side: str
    volume: float
    entry: float
    stop: float
    target: float
    profit: float


class HealthOut(BaseModel):
    connected: bool
    tradingEnabled: bool
