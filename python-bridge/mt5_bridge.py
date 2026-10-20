"""
python-bridge/mt5_bridge.py
------------------------------
Exposes the official `MetaTrader5` Python package over a local HTTP API,
so the Node/Electron app can talk to your own MT5 terminal directly —
no MetaApi account, token, or monthly fee.

Requirements (same machine as the MT5 terminal, Windows only — this is a
limitation of the MetaTrader5 package itself, not of this script):
    pip install -r requirements.txt

Before starting this bridge, open your MT5 terminal and log into the
account you want the bot to trade (demo account while testing). This
script attaches to that already-running, already-logged-in terminal —
it does not need your password.

Run:
    python mt5_bridge.py
    # optional: set MT5_BRIDGE_PORT (default 8787) and MT5_TERMINAL_PATH
    # (only needed if you have multiple terminals installed and must pick one)

IMPORTANT — read this before trusting it with real money:
  - Fixed stop-loss/take-profit sent with an order ARE held by your broker's
    server for most brokers' execution modes, and will still fire even if
    this bridge, the bot, or your PC goes offline afterward.
  - A TRAILING stop is NOT server-side in plain MT5. This bridge only moves
    a position's stop when /orders/<id>/modify is called — which only
    happens while this bridge AND the Node app's position-management loop
    are both running. If you close the terminal or turn off your PC, the
    stop stays wherever it last was, it does not keep trailing. This is the
    real trade-off vs MetaApi.cloud (whose hosted terminal runs the trail
    24/7 regardless of your own machine's state) — see execution/mt5/README.md.
"""
import os
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, request

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # optional — falls back to real environment variables if python-dotenv isn't installed

try:
    import MetaTrader5 as mt5
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "The MetaTrader5 package is not installed, or you're not on Windows "
        "(it's a Windows-only package that wraps the MT5 terminal's own API). "
        "Run: pip install -r requirements.txt"
    ) from exc

app = Flask(__name__)

PORT = int(os.environ.get("MT5_BRIDGE_PORT", "8787"))
TERMINAL_PATH = os.environ.get("MT5_TERMINAL_PATH")  # only needed with multiple terminals installed
MAGIC = 990321  # tags orders this bot places, so you can tell them apart from manual trades

TIMEFRAME_MAP = {
    "1m": mt5.TIMEFRAME_M1,
    "5m": mt5.TIMEFRAME_M5,
    "15m": mt5.TIMEFRAME_M15,
    "30m": mt5.TIMEFRAME_M30,
    "1h": mt5.TIMEFRAME_H1,
    "4h": mt5.TIMEFRAME_H4,
    "1d": mt5.TIMEFRAME_D1,
}


def ensure_initialized():
    """Attach to the already-running, already-logged-in MT5 terminal. Safe to call repeatedly."""
    if TERMINAL_PATH:
        ok = mt5.initialize(path=TERMINAL_PATH)
    else:
        ok = mt5.initialize()
    if not ok:
        code, msg = mt5.last_error()
        raise RuntimeError(f"mt5.initialize() failed ({code}): {msg}. Is the MT5 terminal open and logged in?")


@app.before_request
def _attach():
    ensure_initialized()


@app.errorhandler(Exception)
def handle_error(err):
    return jsonify({"error": str(err)}), 500


@app.route("/health")
def health():
    start = time.time()
    info = mt5.terminal_info()
    latency_ms = round((time.time() - start) * 1000)
    connected = bool(info and info.connected)
    return jsonify({"connected": connected, "latencyMs": latency_ms})


@app.route("/account")
def account():
    info = mt5.account_info()
    if info is None:
        code, msg = mt5.last_error()
        return jsonify({"error": f"account_info() failed ({code}): {msg}"}), 500

    # Distinct from account-level trade_allowed: this is the terminal's own
    # AutoTrading toggle (Tools > Options > Expert Advisors, or the toolbar
    # button). An order can be rejected with retcode 10027 even when the
    # account itself is fully permitted to trade, if this is off.
    try:
        terminal = mt5.terminal_info()
        terminal_trade_allowed = bool(terminal.trade_allowed) if terminal else False
    except Exception:
        terminal_trade_allowed = None  # unknown — don't let this break connecting at all

    return jsonify({
        "equity": info.equity,
        "balance": info.balance,
        "tradeAllowed": bool(info.trade_allowed),
        "terminalTradeAllowed": terminal_trade_allowed,
        "broker": info.company,
        "server": info.server,
        "currency": info.currency,
    })


@app.route("/candles")
def candles():
    symbol = request.args.get("symbol", "EURUSD")
    timeframe = request.args.get("timeframe", "15m")
    count = int(request.args.get("count", "140"))

    tf = TIMEFRAME_MAP.get(timeframe)
    if tf is None:
        return jsonify({"error": f"Unsupported timeframe '{timeframe}'. Use one of {list(TIMEFRAME_MAP)}"}), 400

    if not mt5.symbol_select(symbol, True):
        return jsonify({"error": f"Could not select symbol '{symbol}' — check it's visible in Market Watch"}), 400

    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None:
        code, msg = mt5.last_error()
        return jsonify({"error": f"copy_rates_from_pos() failed ({code}): {msg}"}), 500

    return jsonify([
        {
            "time": int(r["time"]) * 1000,
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["tick_volume"]),
        }
        for r in rates
    ])


@app.route("/spread")
def spread():
    symbol = request.args.get("symbol", "EURUSD")
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({"error": f"No tick data for '{symbol}'"}), 400
    return jsonify({"spread": round(tick.ask - tick.bid, 6)})


@app.route("/positions")
def positions():
    positions = mt5.positions_get() or ()
    return jsonify([
        {
            "id": str(p.ticket),
            "instrument": p.symbol,
            "side": "LONG" if p.type == mt5.ORDER_TYPE_BUY else "SHORT",
            "entry": p.price_open,
            "stop": p.sl,
            "target": p.tp,
            "currentPrice": p.price_current,
            "profit": p.profit,
            "openTime": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
        }
        for p in positions
        if p.magic == MAGIC
    ])


@app.route("/positions/<position_id>/history")
def position_history(position_id):
    """
    Used to reconcile a position this app thought was open after MT5 has
    already closed it server-side (stop-loss, take-profit, or trailing
    stop firing while nobody was watching). `position=` returns every deal
    tied to that ticket regardless of when it happened, so no time-range
    guessing is needed. Returns null (not an error) if nothing is found —
    the caller falls back to an estimate rather than treating that as fatal.
    """
    try:
        ticket = int(position_id)
    except (TypeError, ValueError):
        return jsonify({"error": f"Invalid position id '{position_id}'"}), 400

    deals = mt5.history_deals_get(position=ticket)
    if not deals:
        return jsonify(None)

    exit_deals = [d for d in deals if d.entry == mt5.DEAL_ENTRY_OUT]
    if not exit_deals:
        return jsonify(None)

    exit_deal = max(exit_deals, key=lambda d: d.time)
    return jsonify({
        "exitPrice": exit_deal.price,
        "exitTime": datetime.fromtimestamp(exit_deal.time, tz=timezone.utc).isoformat(),
        "profit": exit_deal.profit,
    })


@app.route("/symbol/<symbol>/info")
def symbol_info_route(symbol):
    """
    Feeds risk-based position sizing (core/risk/PositionSizer.ts): the tick
    size/value are what convert "risk 1% of equity" into an actual lot
    size for THIS symbol, since a pip is worth a different amount on
    EURUSD vs USDJPY vs a JPY-quoted cross.
    """
    info = mt5.symbol_info(symbol)
    if info is None:
        return jsonify({"error": f"No symbol info for '{symbol}' — check it's visible in Market Watch"}), 400
    return jsonify({
        "digits": info.digits,
        "tickSize": info.trade_tick_size,
        "tickValue": info.trade_tick_value,
        "volumeMin": info.volume_min,
        "volumeMax": info.volume_max,
        "volumeStep": info.volume_step,
    })


def resolve_filling_type(symbol):
    """
    The #1 first-integration MT5 API gotcha: not every broker/symbol
    supports every fill type, and sending the wrong one gets the whole
    order rejected with an opaque retcode. symbol_info().filling_mode is a
    bitmask of what THIS symbol actually supports — read it instead of
    guessing.

    The MetaTrader5 Python package does not expose SYMBOL_FILLING_FOK /
    SYMBOL_FILLING_IOC as module attributes (only the ORDER_FILLING_*
    constants used when building an order request are exposed) — these
    bitmask values are stable, documented MQL5 constants
    (SYMBOL_FILLING_FOK=1, SYMBOL_FILLING_IOC=2), so they're used directly.
    """
    SYMBOL_FILLING_FOK_BIT = 1
    SYMBOL_FILLING_IOC_BIT = 2

    info = mt5.symbol_info(symbol)
    if info is None:
        return mt5.ORDER_FILLING_IOC
    mode = info.filling_mode
    if mode & SYMBOL_FILLING_IOC_BIT:
        return mt5.ORDER_FILLING_IOC
    if mode & SYMBOL_FILLING_FOK_BIT:
        return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN


def round_price(symbol, price):
    """Unrounded floats are a common cause of 'Invalid price' rejections — round to the symbol's own digit count."""
    info = mt5.symbol_info(symbol)
    return round(price, info.digits) if info else price


def validate_stop_distance(symbol, current_price, stop, target):
    """
    The #2 common gotcha: brokers reject SL/TP placed closer to price than
    their own minimum distance (trade_stops_level, in points). Returning a
    clear error here means the Node app logs "stop too close to market",
    not a bare MT5 retcode number.
    """
    info = mt5.symbol_info(symbol)
    if info is None or info.trade_stops_level <= 0:
        return None
    min_distance = info.trade_stops_level * info.point
    if abs(current_price - stop) < min_distance:
        return (
            f"Stop is {abs(current_price - stop):.5f} from price; "
            f"{symbol} requires at least {min_distance:.5f} ({info.trade_stops_level} points)"
        )
    if abs(current_price - target) < min_distance:
        return (
            f"Target is {abs(current_price - target):.5f} from price; "
            f"{symbol} requires at least {min_distance:.5f} ({info.trade_stops_level} points)"
        )
    return None


def resolve_volume(symbol, requested):
    """
    The #3 common gotcha: a lot size below the symbol's minimum (or not a
    multiple of its step) is rejected outright. Snap to what the broker
    will actually accept and say so, rather than let order_send fail.
    """
    info = mt5.symbol_info(symbol)
    if info is None:
        return requested, None
    if requested < info.volume_min:
        return info.volume_min, f"Requested volume {requested} below {symbol}'s minimum {info.volume_min} — using minimum instead"
    if requested > info.volume_max:
        return info.volume_max, f"Requested volume {requested} above {symbol}'s maximum {info.volume_max} — capping"
    steps = round((requested - info.volume_min) / info.volume_step)
    snapped = round(info.volume_min + steps * info.volume_step, 8)
    return snapped, None


@app.route("/orders", methods=["POST"])
def submit_order():
    body = request.get_json(force=True)
    symbol = body["instrument"]
    side = body["side"]  # "LONG" | "SHORT"
    stop = float(body["stop"])
    target = float(body["target"])
    requested_volume = float(body.get("volume", 0.01))
    print(f"[order] REQUEST received: {side} {symbol} stop={stop} target={target} volume={requested_volume}")
    try:
        terminal = mt5.terminal_info()
        print(
            f"[order] terminal state at request time: "
            f"trade_allowed={bool(terminal.trade_allowed) if terminal else 'terminal_info() returned None'}, "
            f"connected={bool(terminal.connected) if terminal else '?'}"
        )
    except Exception as diag_err:  # never let a diagnostic print block a real order attempt
        print(f"[order] (could not read terminal diagnostics: {diag_err})")

    if not mt5.symbol_select(symbol, True):
        return jsonify({
            "error": f"Could not select symbol '{symbol}' — check it's visible in Market Watch. "
                     f"Some brokers use a suffix (e.g. 'EURUSD.a' or 'EURUSDm') — check your watchlist "
                     f"matches your broker's exact symbol names."
        }), 400

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({"error": f"No tick data for '{symbol}'"}), 400

    order_type = mt5.ORDER_TYPE_BUY if side == "LONG" else mt5.ORDER_TYPE_SELL
    price = round_price(symbol, tick.ask if side == "LONG" else tick.bid)
    stop = round_price(symbol, stop)
    target = round_price(symbol, target)

    stop_error = validate_stop_distance(symbol, price, stop, target)
    if stop_error:
        return jsonify({"error": stop_error}), 400

    volume, volume_warning = resolve_volume(symbol, requested_volume)
    if volume_warning:
        print(f"WARNING: {volume_warning}")

    order_request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "sl": stop,
        "tp": target,
        "deviation": 20,
        "magic": MAGIC,
        "comment": "trading-platform",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": resolve_filling_type(symbol),
    }
    print(f"[order] {side} {symbol} vol={volume} sl={stop} tp={target} price={price}")
    result = mt5.order_send(order_request)
    print(f"[order] result: retcode={result.retcode if result else None}, comment={result.comment if result else None}, last_error={mt5.last_error()}")
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        code, msg = mt5.last_error()
        retcode = result.retcode if result else None
        return jsonify({"error": f"order_send failed (retcode={retcode}, last_error={code}: {msg})"}), 500

    return jsonify({
        "id": str(result.order if result.order else result.deal),
        "instrument": symbol,
        "side": side,
        "entry": result.price,
        "stop": stop,
        "target": target,
        "volume": volume,
        "stringCode": str(result.retcode),
    })


def _find_position(position_id: str):
    positions = mt5.positions_get(ticket=int(position_id))
    if not positions:
        return None
    return positions[0]


@app.route("/orders/<position_id>/close", methods=["POST"])
def close_order(position_id):
    """
    Full close by default. Pass {"volume": X} in the body for a PARTIAL
    close (used by the partial-take-profit step) — X is snapped to the
    symbol's volume step the same way a new order's volume is, and capped
    at the position's own remaining volume so an over-large request can't
    ask MT5 to close more than exists.
    """
    pos = _find_position(position_id)
    if pos is None:
        return jsonify({"error": f"Position {position_id} not found (already closed?)"}), 404

    body = request.get_json(silent=True) or {}
    requested_volume = body.get("volume")
    if requested_volume is None:
        volume = pos.volume
    else:
        volume, _ = resolve_volume(pos.symbol, min(float(requested_volume), pos.volume))
    is_partial = volume < pos.volume

    tick = mt5.symbol_info_tick(pos.symbol)
    close_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = round_price(pos.symbol, tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask)

    order_request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": volume,
        "type": close_type,
        "position": pos.ticket,
        "price": price,
        "deviation": 20,
        "magic": MAGIC,
        "comment": "trading-platform partial close" if is_partial else "trading-platform close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": resolve_filling_type(pos.symbol),
    }
    result = mt5.order_send(order_request)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        code, msg = mt5.last_error()
        return jsonify({"error": f"close failed (last_error={code}: {msg})"}), 500

    return jsonify({"price": result.price, "stringCode": str(result.retcode), "volume": volume})


@app.route("/orders/<position_id>/modify", methods=["POST"])
def modify_order(position_id):
    """
    Moves a position's stop (and optionally target) — this is how break-even
    and trailing-stop moves actually reach the broker in native-MT5 mode.
    Unlike MetaApi's cloud-hosted trailing config, this only takes effect
    when called: the Node app's PositionManager loop must call this
    endpoint on an interval for a trailing stop to actually trail. See the
    module docstring above.
    """
    pos = _find_position(position_id)
    if pos is None:
        return jsonify({"error": f"Position {position_id} not found (already closed?)"}), 404

    body = request.get_json(force=True)
    new_stop = round_price(pos.symbol, float(body.get("stop", pos.sl)))
    new_target = round_price(pos.symbol, float(body.get("target", pos.tp)))

    order_request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": pos.symbol,
        "position": pos.ticket,
        "sl": new_stop,
        "tp": new_target,
        "magic": MAGIC,
    }
    result = mt5.order_send(order_request)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        code, msg = mt5.last_error()
        return jsonify({"error": f"modify failed (last_error={code}: {msg})"}), 500

    return jsonify({"stringCode": str(result.retcode)})


if __name__ == "__main__":
    ensure_initialized()
    info = mt5.account_info()

    try:
        terminal = mt5.terminal_info()
        if terminal:
            print(f"Attached terminal path: {terminal.path}")
            print(f"AutoTrading enabled on THIS terminal instance: {bool(terminal.trade_allowed)}")
            if not terminal.trade_allowed:
                print(
                    "^^^ This is False. If you already enabled AutoTrading in a terminal window, "
                    "that terminal is NOT the one this bridge attached to — likely because "
                    "mt5.initialize() found/launched a different installation. Set MT5_TERMINAL_PATH "
                    "(in python-bridge/.env or as an env var) to the exact terminal64.exe path shown "
                    "above vs. the one you have open, or close all other MT5 installations and retry."
                )
        else:
            print("WARNING: could not read terminal_info() at all — is MT5 actually running?")
    except Exception as diag_err:
        print(f"(could not read terminal diagnostics at startup: {diag_err})")

    if info:
        print(f"Attached to MT5 terminal — account {info.login} on {info.server}, equity {info.equity}")
    else:
        print("WARNING: attached to MT5 terminal but account_info() returned nothing — are you logged in?")
    print(f"Bridge listening on http://localhost:{PORT}")
    app.run(host="127.0.0.1", port=PORT)
