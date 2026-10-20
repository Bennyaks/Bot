# MT5 execution adapter — status: stub, not connected

See `../metaapi/README.md` for the adapter that's actually wired up
(`MetaApiBroker`). This file documents the *self-hosted* alternative if you
ever want to run your own bridge instead of MetaApi.cloud.

MetaTrader 5 does not expose a browser-reachable API. The official way to
talk to it programmatically is the `MetaTrader5` Python package, which
requires the MT5 terminal running on Windows (or under Wine) on the same
machine as the Python process.

`MT5Broker.ts` implements the same `Broker` and `ExecutionProvider`
interfaces as `PaperBroker` and `MetaApiBroker`, so it slots into the
`SystemOrchestrator` without any other code changing — but it does so by
calling a **bridge service** you would need to run separately:

```
Node process (this repo)  --REST/WebSocket-->  Bridge service (Python)  --MetaTrader5 pkg-->  MT5 terminal (Wine or Windows)
```

## What the bridge service needs to expose

- `GET  /health` → `{ connected: bool, latencyMs: number }`
- `GET  /account` → `{ equity: number }`
- `POST /orders` → submit a candidate, returns a filled/rejected order
- `POST /orders/:id/close` → close a position at market

Tools like `mt5linux` (PyPI) or a small FastAPI wrapper around the
`MetaTrader5` package can serve as this bridge.

## Using MT5Broker once a bridge exists

```ts
const mt5 = new MT5Broker('http://localhost:8787');
const orchestrator = new SystemOrchestrator({ broker: mt5, execution: mt5, notifier });
```

Until a bridge is running at that URL, every call on `MT5Broker` will
reject with a network error — that's expected.
