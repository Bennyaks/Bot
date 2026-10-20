# MT5 Bridge

A small local HTTP service that exposes a running MetaTrader 5 terminal —
candles, spread, account equity, open positions, and (once you enable it)
order submit/close — to the Analysis Engine app. This is what a real
`MT5MarketProvider`/`MT5Broker` on the JS side talk to, instead of the
simulated `ReplayMarketProvider`/`PaperBroker`.

**This only runs on Windows.** The official `MetaTrader5` Python package
talks to the terminal via local IPC and has no Linux/Mac equivalent —
that's a constraint of MetaTrader itself, not something this bridge can
work around.

## 1. Get an MT5 account

Any broker offering the MetaTrader 5 platform works. **Open a demo account
first** — this bridge defaults to read-only (see step 4) specifically so
you can verify everything against a demo before it can touch real money.

## 2. Install the MT5 terminal

Download and install the MetaTrader 5 terminal from your broker, log into
your account, and **leave it open and logged in**. This bridge talks to
the running terminal process — it does not connect to your broker
directly.

In the terminal: **Tools → Options → Expert Advisors → check "Allow
Algo Trading"**. Without this, order submission will fail even with
`MT5_BRIDGE_ALLOW_TRADING=true`.

Also add every instrument you plan to use (EURUSD, GBPUSD, etc.) to
**Market Watch** — `/candles` and `/spread` return errors for a symbol
that isn't visible there.

## 3. Install this bridge

On the same Windows machine:

```powershell
cd mt5-bridge
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Edit `.env`:
- `MT5_LOGIN` / `MT5_PASSWORD` / `MT5_SERVER` — from your account (the
  server name is shown in the terminal's login window, e.g.
  `ICMarketsSC-Demo`).
- `MT5_BRIDGE_API_KEY` — generate a real one:
  ```powershell
  python -c "import secrets; print(secrets.token_hex(32))"
  ```
- Leave `MT5_BRIDGE_ALLOW_TRADING=false` for now.

## 4. Run it

```powershell
python run.py
```

You should see `Connected. Trading is DISABLED (read-only).` in the log.
If it instead fails to connect, the error message tells you what
`mt5.initialize()` reported — almost always a wrong login/password/server,
or the terminal not being open.

Verify it's actually working, from anywhere with `curl` or a browser:

```powershell
curl http://127.0.0.1:8787/health
curl -H "X-API-Key: <your key>" http://127.0.0.1:8787/account
curl -H "X-API-Key: <your key>" "http://127.0.0.1:8787/candles?symbol=EURUSD&timeframe=15m&count=10"
curl -H "X-API-Key: <your key>" "http://127.0.0.1:8787/spread?symbol=EURUSD"
```

`/account` should show your demo account's real balance/equity.
`/candles` should show real recent price history for EURUSD, not a
generated series. If these look right, the read side is done.

## 5. Only once the above looks correct: enable trading

Set `MT5_BRIDGE_ALLOW_TRADING=true` in `.env` and restart. `/orders` and
`/orders/close` will now actually place and close real orders on the
account in `.env` — on a demo account this is safe to test freely; on a
real account, this is the point where actual money is on the line every
time something calls it.

## API reference

All endpoints except `/health` require an `X-API-Key` header matching
`MT5_BRIDGE_API_KEY`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ connected, tradingEnabled }` — no auth required, so a caller can check the bridge is up before authenticating anything else |
| GET | `/account` | Balance, equity, margin, currency |
| GET | `/spread?symbol=EURUSD` | Current spread in price units (not pips) |
| GET | `/candles?symbol=EURUSD&timeframe=15m&count=150` | Recent OHLCV candles, most recent last. `timeframe` accepts `1m,5m,15m,30m,1h,4h,1d` |
| GET | `/positions` | Every currently open position on the account |
| POST | `/orders` | Body: `{symbol, side: "LONG"\|"SHORT", volume, stop, target}` → `{ticket, price, volume}`. 422 if trading is disabled. |
| POST | `/orders/close` | Body: `{ticket, symbol, side, volume}` → `{price, volume}` |

A `503` means the bridge can't reach the MT5 terminal at all (restart it,
or check the terminal is open). A `422` on an order call means the order
itself was rejected (trading disabled, invalid symbol, market closed,
etc.) — the response `detail` includes MT5's own error message.

## Security notes

- `MT5_BRIDGE_API_KEY` is the actual access control, not the host
  binding — don't skip generating a real one.
- Default `MT5_BRIDGE_HOST=127.0.0.1` means only the same machine can
  reach the bridge. If the Analysis Engine app runs elsewhere, don't just
  flip this to `0.0.0.0` on an open network — firewall the port to the
  specific machine that needs it, or put this behind a VPN/reverse proxy
  with its own auth.
- Never commit `.env`. `MT5_LOGIN`/`MT5_PASSWORD` are real account
  credentials and `MT5_BRIDGE_API_KEY` is a real secret.

## What's still missing on the Analysis Engine (TS) side

This bridge is the Windows-side half. The other half — an
`MT5MarketProvider` implementing the app's existing `MarketProvider`
interface and a real `MT5Broker` implementing `ExecutionProvider`, both
calling this bridge over HTTP instead of simulating — hasn't been written
yet. The interfaces they need to satisfy already exist and haven't
changed shape for this; that's the next piece once this bridge is up and
you've confirmed `/account`/`/candles`/`/spread` look right against your
real terminal.
