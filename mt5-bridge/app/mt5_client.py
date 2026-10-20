"""
app.mt5_client
---------------
Thin wrapper around the `MetaTrader5` package — the only file in this
service that imports it directly. That import is deferred into
`MT5Client.connect()` rather than done at module load, so the rest of this
codebase (config parsing, the timeframe map, the FastAPI route wiring) can
still be imported and read/reasoned about on a machine that doesn't have
the package installed — which, in practice, is everywhere except the
actual Windows box this is meant to run on.

Every method funnels through a single lock. That isn't a style choice:
the underlying `MetaTrader5` package is a ctypes wrapper around the
terminal's own local IPC and is documented as not safe for concurrent
calls from multiple threads — two requests hitting `mt5.order_send` at
the same instant can corrupt each other's request. FastAPI can still
serve multiple requests concurrently; they just serialize here at the
point they actually touch the terminal.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any

from .config import Settings

# Maps the timeframe strings the JS side already uses (Candle/MarketProvider
# convention — '15m', '1h', etc) to the MetaTrader5 package's own constants,
# which are only resolvable once the module is imported (hence a name
# lookup here rather than importing mt5 at module scope).
TIMEFRAME_ATTR_MAP = {
    "1m": "TIMEFRAME_M1",
    "5m": "TIMEFRAME_M5",
    "15m": "TIMEFRAME_M15",
    "30m": "TIMEFRAME_M30",
    "1h": "TIMEFRAME_H1",
    "4h": "TIMEFRAME_H4",
    "1d": "TIMEFRAME_D1",
}


def resolve_timeframe(mt5module: Any, timeframe: str) -> int:
    attr = TIMEFRAME_ATTR_MAP.get(timeframe.lower())
    if attr is None:
        supported = ", ".join(TIMEFRAME_ATTR_MAP)
        raise ValueError(f"Unsupported timeframe '{timeframe}'. Supported: {supported}")
    return getattr(mt5module, attr)


@dataclass
class Candle:
    """Field names match the TS `Candle` type exactly — `time` is epoch milliseconds, same convention as everywhere else in this app."""

    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class MT5ConnectionError(RuntimeError):
    """The terminal is unreachable, not logged in, or a data call otherwise failed at the connection level."""


class MT5OrderError(RuntimeError):
    """An order submit/close call was rejected — message includes MT5's own retcode/comment where available."""


class MT5Client:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._lock = threading.Lock()
        self._mt5: Any = None
        self._connected = False

    # -- connection lifecycle -------------------------------------------------

    def connect(self) -> None:
        try:
            import MetaTrader5 as mt5  # noqa: N814 — package's own casing
        except ImportError as exc:
            raise MT5ConnectionError(
                "The MetaTrader5 package is not installed in this Python "
                "environment. On the Windows machine running this bridge: "
                "pip install MetaTrader5"
            ) from exc

        with self._lock:
            self._mt5 = mt5
            kwargs: dict[str, Any] = {}
            if self._settings.mt5_terminal_path:
                kwargs["path"] = self._settings.mt5_terminal_path
            initialized = mt5.initialize(
                login=self._settings.mt5_login,
                password=self._settings.mt5_password,
                server=self._settings.mt5_server,
                **kwargs,
            )
            if not initialized:
                error = mt5.last_error()
                self._connected = False
                raise MT5ConnectionError(
                    f"mt5.initialize() failed: {error}. Check that the MT5 "
                    "terminal is installed and logged into this account/server, "
                    "and that 'Algo Trading' is enabled in the terminal if you "
                    "intend to submit orders through this bridge."
                )
            self._connected = True

    def disconnect(self) -> None:
        with self._lock:
            if self._mt5 is not None:
                self._mt5.shutdown()
            self._connected = False

    def is_connected(self) -> bool:
        if not self._connected or self._mt5 is None:
            return False
        with self._lock:
            info = self._mt5.terminal_info()
        return info is not None and bool(info.connected)

    def _require_connected(self) -> None:
        if not self.is_connected():
            raise MT5ConnectionError(
                "Not connected to the MT5 terminal. Restart the bridge, and "
                "confirm the terminal itself is open and logged in."
            )

    # -- account / market data -------------------------------------------------

    def account_summary(self) -> dict[str, Any]:
        self._require_connected()
        with self._lock:
            info = self._mt5.account_info()
        if info is None:
            raise MT5ConnectionError(f"account_info() returned nothing: {self._mt5.last_error()}")
        return {
            "login": info.login,
            "server": self._settings.mt5_server,
            "balance": float(info.balance),
            "equity": float(info.equity),
            "margin": float(info.margin),
            "marginFree": float(info.margin_free),
            "currency": info.currency,
        }

    def get_spread(self, symbol: str) -> float:
        self._require_connected()
        with self._lock:
            tick = self._mt5.symbol_info_tick(symbol)
            info = self._mt5.symbol_info(symbol)
        if tick is None or info is None:
            raise MT5ConnectionError(
                f"No tick/symbol data for '{symbol}' — is it visible in the terminal's Market Watch?"
            )
        if tick.ask and tick.bid:
            return float(tick.ask - tick.bid)
        # Fallback for a symbol whose tick doesn't carry ask/bid directly —
        # derive from the broker-reported spread (in points) and point size.
        return float(info.spread) * float(info.point)

    def get_candles(self, symbol: str, timeframe: str, count: int) -> list[Candle]:
        self._require_connected()
        with self._lock:
            tf = resolve_timeframe(self._mt5, timeframe)
            rates = self._mt5.copy_rates_from_pos(symbol, tf, 0, count)
        if rates is None:
            raise MT5ConnectionError(
                f"copy_rates_from_pos returned nothing for {symbol}/{timeframe}: "
                f"{self._mt5.last_error()}. Is '{symbol}' visible in Market Watch?"
            )
        return [
            Candle(
                time=int(r["time"]) * 1000,
                open=float(r["open"]),
                high=float(r["high"]),
                low=float(r["low"]),
                close=float(r["close"]),
                volume=float(r["tick_volume"]),
            )
            for r in rates
        ]

    def list_open_positions(self) -> list[dict[str, Any]]:
        self._require_connected()
        with self._lock:
            positions = self._mt5.positions_get()
        if positions is None:
            return []
        return [
            {
                "ticket": p.ticket,
                "symbol": p.symbol,
                "side": "LONG" if p.type == 0 else "SHORT",
                "volume": float(p.volume),
                "entry": float(p.price_open),
                "stop": float(p.sl),
                "target": float(p.tp),
                "profit": float(p.profit),
            }
            for p in positions
        ]

    # -- trading (gated by MT5_BRIDGE_ALLOW_TRADING) ----------------------------

    def submit_order(
        self, symbol: str, side: str, volume: float, stop: float, target: float, deviation_points: int = 20
    ) -> dict[str, Any]:
        self._require_connected()
        self._require_trading_enabled()
        with self._lock:
            mt5 = self._mt5
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                raise MT5OrderError(f"No tick for '{symbol}' — is it in Market Watch?")
            is_buy = side.upper() == "LONG"
            price = tick.ask if is_buy else tick.bid
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": volume,
                "type": mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL,
                "price": price,
                "sl": stop,
                "tp": target,
                "deviation": deviation_points,
                "type_filling": mt5.ORDER_FILLING_IOC,
                "type_time": mt5.ORDER_TIME_GTC,
                "comment": "analysis-engine",
            }
            result = mt5.order_send(request)
        self._raise_if_order_failed(result, "submit")
        return {"ticket": result.order, "price": float(result.price), "volume": float(result.volume)}

    def close_position(
        self, ticket: int, symbol: str, side: str, volume: float, deviation_points: int = 20
    ) -> dict[str, Any]:
        self._require_connected()
        self._require_trading_enabled()
        with self._lock:
            mt5 = self._mt5
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                raise MT5OrderError(f"No tick for '{symbol}' — is it in Market Watch?")
            # Closing a LONG means selling; closing a SHORT means buying back.
            is_buy_to_close = side.upper() == "SHORT"
            price = tick.ask if is_buy_to_close else tick.bid
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": volume,
                "type": mt5.ORDER_TYPE_BUY if is_buy_to_close else mt5.ORDER_TYPE_SELL,
                "position": ticket,
                "price": price,
                "deviation": deviation_points,
                "type_filling": mt5.ORDER_FILLING_IOC,
                "type_time": mt5.ORDER_TIME_GTC,
                "comment": "analysis-engine-close",
            }
            result = mt5.order_send(request)
        self._raise_if_order_failed(result, "close")
        return {"price": float(result.price), "volume": float(result.volume)}

    def _require_trading_enabled(self) -> None:
        if not self._settings.allow_trading:
            raise MT5OrderError(
                "Trading is disabled on this bridge (MT5_BRIDGE_ALLOW_TRADING is not "
                "'true'). This is the deliberate default, not a bug — verify /account, "
                "/candles, and /spread look correct first, and only enable trading once "
                "you're ready for this bridge to place and close real orders."
            )

    def _raise_if_order_failed(self, result: Any, action: str) -> None:
        if result is None:
            raise MT5OrderError(f"{action} order_send returned None: {self._mt5.last_error()}")
        if result.retcode != self._mt5.TRADE_RETCODE_DONE:
            raise MT5OrderError(f"{action} order_send failed (retcode={result.retcode}): {result.comment}")
