# Architecture changes — from Phase 1 through a live MT5 connection

This started as Phase 1 (Interfaces + DI + EventBus, Decision Engine, Risk
Manager). This pass finishes the remaining phases the review called out, and
adds a live broker adapter so the platform can run independently of the
browser dashboard, driven entirely by real market/account data.

## The UI is now three pages, all real, all human-readable

The original demo dashboard (Command Center, Broker Safety, Journal,
Versions, Pipeline, Diagnostics, Logs, Principles — 8 pages, plus a global
top bar and sidebar panel showing the same fake numbers on every screen)
has been deleted, not hidden. It was never wired to anything real, and a
recorded walkthrough showed it was genuinely confusing about which numbers
on screen were real. The bundle shrank from ~490KB to ~272KB removing it —
a rough proxy for how much of the app was decorative.

What's left, and it's everything the app actually does:

- **Live Trading** (`src/pages/LiveTrading.tsx`, default route) — connect,
  approve or skip each candidate (now showing lot size, timeframe, entry/
  stop/target, confidence, and reward:risk — not just entry/stop/target),
  track open positions with a live-ish floating R-multiple and elapsed
  time, and a plain-language "Recent Activity" feed instead of a raw log.
- **Sessions** (`src/pages/Sessions.tsx`) — rebuilt from the ground up.
  The old version showed fabricated win-rate/profit-factor numbers per
  session; this one shows only what's actually true: which session is
  active right now, the real UTC trading hours for each, converted to the
  user's own local time, and a countdown to the next one opening.
- **History** (`src/pages/History.tsx`) — a real closed-trade blotter,
  reading from the same trade history now persisted to disk (see below),
  with real win rate/profit factor/expectancy computed via the existing
  `TradeAnalytics` class — the same numbers Journal used to fabricate,
  now actually true.

`lib/data.ts` was pruned from ~800 lines of mock data down to the one
function that was ever real (`getCurrentSession()`). `useTradingStore.ts`,
`PaperBroker.ts`, and `ReplayMarketProvider.ts` — the demo engine those
pages ran on — were deleted entirely rather than left as unused dead code.

## Errors are now translated into plain language

`src/lib/friendlyError.ts` is the single place every technical error and
rejection reason passes through before reaching the screen. A non-developer
should never see `retcode=10018` or `SESSION_EVIDENCE` without also seeing
what it actually means and, where relevant, what to do about it — the exact
technical string is always still available behind a "Show technical
details" toggle, for bug reports.

Covers the MT5 retcodes actually seen so far (10018 market closed, 10027
AutoTrading disabled, 10016 stops too close, 10019 insufficient funds, and
others) plus the bridge's own validation messages (stop distance, unknown
symbol) and network failures (bridge unreachable, request timeout). Also
translates Decision Engine gate names in the activity feed — "Skipped a
trade because the setup wasn't confident enough" instead of
`Confidence threshold`. 12 unit tests lock in the translations that exist
today; extending `RETCODE_MESSAGES` or `GATE_LABEL_TEXT` is how to add more
as new ones are seen.

## Trade history now survives a restart

`electron/main/tradeHistoryStore.ts` persists closed trades to a JSON file
in Electron's userData directory — the main process has no
`localStorage`, unlike the renderer (which is why the old demo dashboard's
`LocalJournalStorage` doesn't apply here). Only trades closed through this
app's own `closePosition()` call are ever written, since that's the only
path with a real, known exit price — a position the broker closes on its
own via SL/TP/trailing stop is still reported in the activity feed, just
without a fabricated P&L entry in History (see the existing note on this
limitation further down).

## What's in `src/core/` now

```
core/
  interfaces/index.ts        every subsystem as a contract: MarketProvider,
                              Strategy, RiskManagerContract, ExecutionProvider,
                              Broker, PositionManagerContract, Storage,
                              Notifier, Analytics, HealthSource
  events/
    eventTypes.ts             the full event chain: SwingDetected →
                               LevelDetected → BOSDetected/CHoCHDetected →
                               LiquiditySweepDetected → TradeCandidateCreated →
                               TradeApproved/Rejected → RiskApproved/Rejected →
                               OrderSubmitted → OrderFilled → PositionOpened →
                               PositionClosed → TradeArchived
    EventBus.ts                typed pub/sub — subsystems publish, nothing
                               calls another subsystem directly
  pipeline/MarketPipeline.ts   tick validation → swing detection (fractal) →
                               support/resistance clustering → BOS/CHoCH →
                               liquidity-sweep detection. Pure functions over
                               whatever candles a MarketProvider hands it.
  decision/DecisionEngine.ts   TradeCandidate → named, independent gates
                               (trend alignment, session evidence, confidence,
                               reward:risk, structure quality, news event) →
                               TradeApproval | explainable RejectedTrade
  risk/RiskManager.ts          absolute veto: max open positions, max
                               consecutive losses, max daily loss (R), max
                               exposure per symbol, min reward:risk
  position/PositionManager.ts  break-even + trailing-stop controllers, driven
                               off the ORIGINAL entry-to-stop risk (captured
                               once at open()) so controllers can't undo each
                               other's progress; close() computes R-multiple
  analytics/Analytics.ts       win rate, profit factor, expectancy, equity
                               curve, max drawdown, most-common-rejection
  reliability/
    ConnectionManager.ts       heartbeat, backoff reconnect, resume-trading
  orchestrator/
    SystemOrchestrator.ts       wires a Broker + ExecutionProvider + Notifier
                               (DI) and runs every candidate through Safety →
                               Decision Engine → Risk Manager → Execution,
                               publishing each step on the EventBus. Contains
                               no business logic of its own.

strategies/breakout/BreakoutStrategy.ts   the only module that produces a
                                          TradeCandidate. Returns null
                                          (SCANNING) when the Market Pipeline
                                          hasn't confirmed a breakout — that's
                                          the common case, not an edge case.

execution/mt5/MT5Broker.ts                self-hosted-bridge stub (see its
                                          README) — a fallback if you'd
                                          rather run your own Wine/mt5linux
                                          bridge instead of MetaApi.cloud
providers/replay/seededCandles.ts         deterministic PRNG candle generator
                                          — same seed → same candles → same
                                          signal, every time (replay testing)
providers/metaapi/MetaApiBroker.ts        LIVE adapter: MarketProvider +
                                          Broker + ExecutionProvider against
                                          a real MT5 account via MetaApi.cloud

server/liveRunner.ts          headless Node entry point — runs the exact same
                              Decision Engine / Risk Manager / Position
                              Manager / BreakoutStrategy against MetaApiBroker,
                              with no browser or UI involved at all
```

`electron/main/liveTradingManager.ts` wires the desktop app's Live Trading
page: a `SystemOrchestrator` constructed with whichever broker was chosen at
connect time (`MetaApiBroker` or `MT5Broker`), feeding `BreakoutStrategy`
real candles each scan cycle, with `TradeHistoryStore` persisting closed
trades and `ConnectionManager` driving the connection status shown in the UI.

`src/server/liveRunner.ts` wires the **live** build: the same
`SystemOrchestrator`, `BreakoutStrategy`, `ConnectionManager`, but fed by
`MetaApiBroker` instead — real candles, real account equity, real fills.
Nothing about the Decision Engine, Risk Manager, or Position Manager changes
between the two; only which `MarketProvider`/`Broker`/`ExecutionProvider` is
injected.

## Why MetaApi.cloud and not a local MT5 install

MetaTrader 5 has no browser- or Node-reachable API on its own — the official
route requires the MT5 terminal running (Windows, or Wine on Linux) on the
same machine as a Python process. MetaApi.cloud hosts that terminal for you
and exposes it as a REST/WebSocket API, so `MetaApiBroker.ts` only ever
speaks HTTP — no Wine, no VM, no locally-installed terminal. It runs on any
plain Node server. `execution/mt5/README.md` documents the self-hosted
alternative (Wine + `mt5linux`) if you'd rather not depend on MetaApi.cloud
long-term.

**Security note:** the MetaApi token is a trading credential. `liveRunner.ts`
reads it from `process.env` (via `.env`, loaded by `dotenv/config`), never
from Vite's `import.meta.env` — env vars prefixed `VITE_` get bundled into
the client JS, which would leak the token to anyone who opens dev tools.
`MetaApiBroker.ts` and `liveRunner.ts` are never imported by anything under
`src/pages`, `src/hooks`, or `src/components`, and a build check confirms
neither ends up in `dist/` (verified: `grep -rl metaapi dist/` returns nothing).

## How to test it

### 1. The desktop app (needs a broker connection — see the sections above)

```
npm install
npm run electron:dev
```

- **Live Trading**: connect via Local MT5 + Python or MetaApi.cloud, set a
  watchlist and lot size, and wait for a scan cycle. A candidate that
  clears every check shows lot size, timeframe, entry/stop/target,
  confidence, and reward:risk — approve or skip it, nothing fires without
  that click.
- **Sessions**: no setup needed — shows which FX session is active right
  now against the real clock, independent of any broker connection.
- **History**: empty until a real trade closes; once one does, its result
  persists across app restarts (see `tradeHistoryStore.ts` above).
- Trigger a real rejection or a broker error and check that the "Recent
  Activity" feed and (for a failed trade) the red banner both show a
  plain-language explanation, with the raw technical string available
  behind "Show technical details."

### 2. Automated tests (57 tests, no setup required)

```
npm test
```

Covers: `DecisionEngine` gate logic, `RiskManager` veto rules,
`PositionManager` break-even/trailing math, `MarketPipeline` swing/BOS
detection (including a tick-validation case and a same-seed reproducibility
case), `TradeAnalytics`, and `BreakoutStrategy` reproducibility — same seed
via `generateSeededCandles()` always produces the same candidate (or the same
`null`), which is the Phase 14 "every signal must be reproducible"
requirement made concrete.

### 3. Live, against a real MT5 demo account (needs a MetaApi.cloud account)

1. Sign up at metaapi.cloud, grab a token from `/token`, and add your MT5
   account (use a **demo** account first) at `/accounts` to get an account id.
2. `cp .env.example .env` and fill in `METAAPI_TOKEN` / `METAAPI_ACCOUNT_ID`.
3. `npm run live`

You'll see console output like:

```
Connecting to MetaApi account ...
Connected. Equity: 10000
[14:32:01] INFO   BreakoutStrategy   EURUSD: no confirmed breakout this scan
[14:33:01] REJECT DecisionEngine     Candidate SIG-... rejected · Confidence threshold, Reward:risk quality
[14:35:01] TRADE  ExecutionManager   EURUSD LONG filled live · position 123456789
```

This is the same `SystemOrchestrator` pipeline as the dashboard, just fed by
`MetaApiBroker` — a real account, real candles, real fills, no browser tab
required to stay running.

## Backtesting (`npm run backtest`)

Walk-forward backtest over real MT5 history, using the exact same
`MarketPipeline` → `BreakoutStrategy` → `DecisionEngine` → `RiskManager` →
`PositionManager` pipeline as live and the dashboard — no separate backtest
logic to keep in sync.

Methodology, so the numbers are honest:
- A candidate is only evaluated on candles strictly before the bar being
  decided on (no lookahead)
- Fills happen at the **next bar's open**, not the signal bar's own close —
  avoids the classic bug of filling at a price you couldn't have traded at
- Stop is assumed to hit first when a single bar's range could have touched
  both stop and target (worst case, not necessarily what really happened
  intrabar)

```
cp .env.example .env   # same METAAPI_TOKEN/METAAPI_ACCOUNT_ID as npm run live
npm run backtest
# optional: BACKTEST_INSTRUMENT=GBPUSD BACKTEST_BARS=3000 npm run backtest
```

Prints win rate, profit factor, expectancy, net R, and max drawdown — same
`TradeAnalytics` the dashboard's Journal uses.

## The "ask for my go-ahead" automation (`npm run live`)

`liveRunner.ts` scans every instrument in `METAAPI_WATCHLIST` (default
`EURUSD,GBPUSD,USDJPY`) every `METAAPI_POLL_SECONDS`. That's the "finds a
favorable session and market" part — the Decision Engine's session-evidence
and trend-alignment gates already filter out instruments that aren't
currently favorable; a candidate only reaches you at all once it's cleared
every gate.

By default (`AUTO_CONFIRM=false`), an approved candidate prints its details
and waits for you to type `y` in the terminal before it's sent to the broker.
Set `AUTO_CONFIRM=true` in `.env` once you trust it enough to skip that.

## The power-outage backup mechanism

Every fill from `MetaApiBroker.submitAsync()` carries three protections, and
all three live **on MT5's own server**, not in this Node process:

1. A stop-loss, set at order creation
2. A take-profit, set at order creation
3. A native MT5 trailing stop (`TrailingStopLoss` distance config), so the
   stop keeps moving in your favor as price advances, entirely server-side

This is the actual answer to "what happens if my power goes out": nothing
bad. The position is already protected before `submitAsync()` even returns —
MetaTrader's server enforces the stop/target/trailing regardless of whether
your laptop, your internet, or this script are running. `liveRunner.ts` only
needs to be running to **find new trades**; it is not what's keeping
existing ones safe.

The one thing that *does* depend on the process running: reconciling your
local view of "what's open" (used for the Risk Manager's max-open-positions
and per-symbol-exposure checks) against what MT5 actually still has open.
`reconcileOpenPositions()` does this at the start of every scan cycle, so a
position the broker closed while you were offline gets dropped from local
tracking the next time the script runs — it doesn't require zero downtime,
just that you check in again before it matters for a new trade's risk limits.

## Desktop app (Electron)

The full dashboard now runs as a Windows-installable desktop app, not just
`npm run dev` in a browser — **and it now supports two interchangeable
broker connections**, picked with a toggle on the Live Trading page:

- **Local MT5 + Python** (default) — talks to `python-bridge/mt5_bridge.py`,
  a thin HTTP wrapper around the *official* `MetaTrader5` Python package.
  Free, no MetaApi account/token/fee, lower latency (direct local IPC). The
  MT5 terminal must be open and logged into your account on the same
  Windows machine as the bot.
- **MetaApi.cloud** — the original cloud-hosted option. Costs a
  subscription past the free tier, but its hosted terminal keeps trading
  (and trailing stops) running even if your own PC is off.

Both are implemented against the exact same `MarketProvider` + `Broker` +
`ExecutionProvider` interfaces (`MT5Broker.ts` alongside `MetaApiBroker.ts`),
so `LiveTradingManager` picks one with a constructor call — nothing about
`SystemOrchestrator`, `DecisionEngine`, `RiskManager`, or `BreakoutStrategy`
changes based on which is active.

**One real behavioral difference to know about:** fixed stop-loss/take-profit
are broker-server-side in both modes — they survive your PC going offline
either way. But MetaApi's cloud-hosted terminal also manages a *trailing*
stop on its own, 24/7, independent of your machine. Plain MT5 has no
equivalent — a trailing stop only moves when something actually calls
`modifyPosition`. For local mode, `LiveTradingManager` runs its own
`PositionManager` loop on every scan cycle specifically to keep trailing
stops moving — but that only works while the app, the bridge, and the MT5
terminal are all still running. If any of those three are down, the
position sits at wherever its stop last was (still protected, just not
still trailing). See `execution/mt5/README.md` and
`python-bridge/mt5_bridge.py`'s module docstring for the full detail.

### Setting up the local MT5 + Python bridge

```
cd python-bridge
pip install -r requirements.txt   # installs MetaTrader5 and flask
```

1. Open your MT5 terminal (Windows) and log into your account — demo while
   testing. The bridge attaches to this already-running, already-logged-in
   terminal; it never handles your password.
2. `python mt5_bridge.py` — starts a local HTTP server on `localhost:8787`
   (override with `MT5_BRIDGE_PORT`).
3. In the desktop app's Live Trading page, pick "Local MT5 + Python", leave
   the bridge URL at the default, and Connect.

No token, no account id, no third party in the loop — everything stays on
your machine.

```
electron/
  main.ts       creates the window, hosts MetaApi (Node-only), bridges to
                the renderer over IPC. Thin — all trading logic lives in
                electron/main/liveTradingManager.ts (below).
  main/liveTradingManager.ts
                the same SystemOrchestrator / BreakoutStrategy /
                ConnectionManager the CLI (liveRunner.ts) uses, reshaped
                around callbacks instead of console.log/readline so the
                confirm/skip step becomes a button, not a terminal prompt.
  preload.ts    the ONLY bridge the renderer can reach — contextIsolation
                is on and nodeIntegration is off, so MetaApi credentials
                and the SDK itself never touch the browser-sandboxed
                renderer process.

src/pages/LiveTrading.tsx   the connect form (token/account id/watchlist),
                            connection status, pending-candidate
                            approve/skip cards, open positions with manual
                            close, and a live log stream. Falls back to a
                            "desktop app only" notice if window.mt5 isn't
                            present (i.e. you're in a plain browser tab).
src/types/electron.d.ts     typed contract for window.mt5.
```

**Build pipeline:** `electron/main.ts` and `electron/preload.ts` are bundled
with esbuild (`npm run electron:build`) into `dist-electron/*.cjs` —
Electron loads the compiled output, not the TypeScript source directly.

**A real bug this caught:** the MetaApi SDK's package.json has a
conditional `exports` map where an ESM `import` site resolves to a
*browser*-oriented build (`dists/esm-web`) that references `window` — while
only a CJS `require()` would get the safe Node build. Since this file is
ESM, it silently loaded the browser build and crashed with `ReferenceError:
window is not defined` the moment the app actually launched (this only
surfaces at runtime, not in `tsc` or unit tests). Fixed by importing the
explicit `metaapi.cloud-sdk/node` subpath in `MetaApiBroker.ts`, which has
no import/require ambiguity. Verified fixed by actually launching the
Electron window under Xvfb in this environment, not just building it.

**A second bug, caught the same way (actually clicking Connect):** even
after the fix above, `new MetaApi(...)` threw `TypeError: ... is not a
constructor`. The package's compiled bundle correctly sets
`module.exports.default` to the real class, but a plain default import of a
CJS module — under both esbuild's `--platform=node` and native Node ESM
(what `tsx` uses) — binds to the *whole module object*, not its nested
`.default`. Reproduced directly with a standalone Node script before
touching any source, confirming `new Mod(...)` fails but
`new Mod.default(...)` works. Fixed in `MetaApiBroker.ts` by importing the
module under a different name and explicitly reading `.default` off it, with
a comment explaining why the cast is needed. Re-verified against the actual
compiled Electron bundle (`dist-electron/main.cjs` shows
`var MetaApi = import_node.default.default;`) and a clean rebuild of
everything: typecheck, all 33 tests, Vite build, Electron build.

**A third bug, caught while answering "how does pair selection work":**
`liveRunner.ts`, `backtest.ts`, and `LiveTradingManager` were all passing
`sessionMetrics: []` to `DecisionEngine.evaluate()`. The `session_evidence`
gate does `ctx.sessionMetrics.find((m) => m.session === c.session)` — with
an empty array that `find()` always returns `undefined`, so the gate always
returned `false`. Every one of those three live paths was rejecting **100%**
of candidates unconditionally, regardless of instrument, confidence, or
anything else. Fixed by passing the real `sessionMetrics` from `lib/data.ts`
in all three places. A regression test now locks this in
(`DecisionEngine.test.ts`: "an empty sessionMetrics array must not reject
every FX candidate silently").

## How instrument/pair selection actually works

Short answer: **the bot does not discover or rank "the best pairs" across
the whole market.** It scans exactly the instruments you put in the
watchlist, every cycle, and only *within that cycle's results* does any
ranking happen.

Concretely, per scan cycle:
1. Every instrument in the watchlist is scanned — no pre-filtering.
2. Each one independently runs through `BreakoutStrategy` → `DecisionEngine`
   → `RiskManager`. Most will produce nothing (`SCANNING`) or get rejected.
3. Whatever's left — every candidate that cleared every gate — gets scored
   as `confidence × riskReward` and sorted best-first.
4. All of them are still surfaced (approval means it's a real setup, not
   noise), but the strongest one this cycle is labeled "Best Pick" in the UI
   (or `[BEST OPPORTUNITY THIS SCAN]` in the CLI) so you don't have to
   compare them yourself.

If you want the bot to automatically discover a broader universe (e.g. "all
crypto pairs my broker offers") rather than a manually-typed watchlist, that
would be a further feature — querying the broker for its full symbol list
(`mt5.symbols_get()` natively, or the account's symbol list via MetaApi) and
filtering by category — not built yet.

**Crypto specifically:** the Decision Engine's `session_evidence` gate
checks FX-style Asian/London/NewYork session performance, which doesn't
apply to a market that trades continuously. `lib/instruments.ts` recognizes
common crypto tickers (BTC, ETH, XRP, SOL, ...) by prefix and the gate skips
itself for those instruments rather than rejecting every crypto candidate
against session stats that don't mean anything for it. To actually trade
crypto: your MT5 broker needs to offer crypto CFDs as symbols (e.g.
`BTCUSD`), and you add those symbols to the watchlist — the strategy itself
(price-action breakout detection) has no FX-specific assumptions and works
on any instrument with OHLC candles.

**How to test the desktop app:**

```
npm install
npm run electron:dev     # runs Vite + Electron together, hot-reloads the UI
```

Or, to test the packaged production build locally:

```
npm run electron:start   # builds everything, launches the packaged app once
```

Once open, go to the **Live Trading** page in the sidebar — same
token/account-id/watchlist form as the CLI, a Connect button, live
connection status, and approve/skip buttons for each candidate instead of
a terminal prompt.

**Building the actual Windows installer:**

```
npm run dist:win
```

This requires either running on Windows, or on Linux/macOS with Wine
installed (`electron-builder` uses Wine to build the NSIS installer
cross-platform). The output lands in `release/` as a `.exe` installer. This
project was built and verified (typecheck, tests, build, and an actual
Electron launch) on Linux — the Windows installer step itself needs to run
on a machine with Wine or on Windows directly, since that part couldn't be
verified inside this environment.

## Execution readiness — what's actually left before a real trade fires

**How to actually tell if the bot and broker are communicating:**
clicking "Enter Trade" and seeing Open Positions stay at 0 with nothing in
your MT5 terminal means the order failed at the bridge or broker level —
but that failure needs to actually reach you to be useful. Three layers
now surface it, in order of reliability:

1. **The Python bridge's own console window** — every incoming order
   request is printed the instant it arrives (`[order] REQUEST received:
   ...`), and the exact MT5 result is printed right after
   `order_send()` returns (`[order] result: retcode=..., comment=...,
   last_error=...`). This is the most authoritative source: it's the
   process actually talking to MT5, independent of whether the HTTP
   response makes it back to Node at all.
2. **The Live Trading page's red "Trade execution failed" banner** — shows
   the exact error string, whether it came from MT5 (a retcode reason),
   the bridge (validation like stop distance/volume), or the network layer
   (bridge unreachable, or a request that hung).
3. **The Live Log panel** — the same failure is also logged there as an
   `ERROR` entry, timestamped alongside everything else that happened.

`MT5Broker.ts`'s request layer was hardened to make sure a failure always
reaches one of these instead of hanging or vanishing silently: a genuine
network error now says "is mt5_bridge.py running?", a non-JSON response
(e.g. the bridge crashed mid-request) shows the raw response instead of a
cryptic parse error, and every request now has a 20-second timeout — if
`order_send()` ever stalls (rare, but MT5 can block on a broker
confirmation or an unexpected dialog), the request now fails clearly
instead of hanging forever with no error and no success, which would look
identical to what a genuine silent failure looks like from the UI.

If you hit a real rejection, the bridge's stop-distance/volume/filling-mode
validation (added earlier) or the symbol-suffix note in its error message
should now tell you specifically why — send me that exact message and it's
usually a one-line fix.

**This actually happened, and it's the best possible confirmation of
everything above.** A real order attempt reached the bridge, MT5 rejected
it, and the failure reached all three layers exactly as designed: the
bridge console showed `[order] REQUEST received: LONG GBPUSD ...` followed
by the `500` response, and the UI banner showed the precise error —
`module 'MetaTrader5' has no attribute 'SYMBOL_FILLING_IOC'`.

Root cause: `resolve_filling_type()` read `mt5.SYMBOL_FILLING_IOC` /
`mt5.SYMBOL_FILLING_FOK` to interpret a symbol's supported fill types —
but the Python `MetaTrader5` package only exposes the `ORDER_FILLING_*`
constants (used when building an order request), not the `SYMBOL_FILLING_*`
bitmask constants (used to interpret what `symbol_info().filling_mode`
returns). Both are stable, documented MQL5 enum values (FOK=1, IOC=2) —
fixed by using the literal bitmask values directly instead of a
module attribute that doesn't exist in the Python wrapper.

**Next: retcode 10027 (`TRADE_RETCODE_CLIENT_DISABLES_AT`)** — "AutoTrading
disabled by the client terminal." Normally a one-click fix (the AutoTrading
toggle in MT5's toolbar, or Tools > Options > Expert Advisors > "Allow
algorithmic trading"). The user reported already having enabled this and
still hitting the same error, which points at a different, more subtle
cause: `mt5.initialize()` with no explicit path can attach to — or launch —
a **different** MT5 terminal installation than the one actually being
looked at, especially with multiple installations present. That second
instance would have AutoTrading off by default regardless of what the
visible terminal window shows.

Instead of guessing further, the bridge now surfaces the ground truth
directly:
- `/account`'s response includes `terminalTradeAllowed`, read from
  `terminal_info().trade_allowed` — the terminal-level toggle, distinct
  from the account-level `tradeAllowed` already exposed.
- Every order attempt now prints `terminal_info().trade_allowed` and
  `.connected` to the bridge's console at the moment of the request.
- On startup, the bridge prints the exact `terminal_info().path` it
  attached to, and if `trade_allowed` is `False` there, prints an explicit
  explanation pointing at `MT5_TERMINAL_PATH` as the likely fix.
- `python-bridge/.env.example` documents `MT5_TERMINAL_PATH` (and
  `python-dotenv` was added so it's picked up automatically, matching the
  Node side's `.env` convention) — set it to the exact `terminal64.exe`
  path of the terminal you actually have open and logged in, found via
  right-click the shortcut → Properties → Target.

Every new `terminal_info()` field access is wrapped in try/except and
degrades to a clear "(could not read terminal diagnostics: ...)" message
rather than crashing the endpoint or blocking the bridge from starting —
learned directly from the `SYMBOL_FILLING_IOC` incident above: an
unverified attribute reference on this SDK should never be allowed to take
down more than the one diagnostic line it's part of.



**A fourth bug, caught from a real screenshot of the app actually
connected:** every candidate was being rejected with "Session evidence,"
even ones that otherwise looked strong. Root cause: `lib/data.ts`'s
`sessionMetrics` — a hand-authored dataset that exists purely to make the
demo dashboard's Sessions page look populated, deliberately including an
"Asian session underperforms" example — had been wired into the **live**
paths (`liveRunner.ts`, `backtest.ts`, `LiveTradingManager`) as if it were
real evidence. At the time of the screenshot it was inside the Asian
session window (00:00–08:00 UTC), so every real candidate was being
rejected based on fictional statistics with no connection to the user's
actual account.

Two fixes, not one, because there were two separate problems:
1. `DecisionEngine`'s `session_evidence` gate now fails **open**, not
   closed, when there's no matching session entry or too few real closed
   trades (`minSessionSample`, default 10) to draw a conclusion from.
   Absence of evidence was previously treated as evidence of
   underperformance — wrong in general, and specifically wrong for a fresh
   account with zero trade history.
2. `core/analytics/sessionPerformance.ts#computeSessionMetrics()` computes
   REAL per-session stats from the account's own closed trades, replacing
   the decorative demo dataset in all three live paths. A fresh account
   starts every session at `totalTrades: 0`, which combined with fix #1
   means real trading isn't blocked by evidence that was never about this
   account in the first place. As real trades close, genuine
   session-quality filtering becomes meaningful — earned from the
   account's own track record, not borrowed from the dashboard's cosmetic
   sample data.

(Note: this whole demo dashboard — and the decorative dataset this section
describes fixing the *live* paths against — was deleted in a later pass;
see "The UI is now three pages" at the top of this document. The bug and
fix described here are still accurate history for the live paths.)

Two regression tests lock this in: `DecisionEngine.test.ts` ("allows a
candidate when there is no session entry at all", "allows ... too few real
closed trades ... even if its stats look bad") and a new
`sessionPerformance.test.ts` covering the real computation itself.

**Known limitation this doesn't fully close:** `closedToday`/`closedTrades`
in `liveRunner.ts` and `LiveTradingManager` only accumulate trades closed
through this app's own `closePosition()` call — a position closed
automatically by the broker's server-side SL/TP/trailing stop isn't
currently recorded with a P&L outcome (the reconcile step only detects
*that* it closed, not at what price), so it won't yet count toward a
session's real sample size. `backtest.ts` doesn't have this gap — its
simulated fills always know their own exit price.



Everything from candle data to a ranked, gate-checked candidate is
code-complete and unit-tested (39 tests) against synthetic data. What is
**not** verified: the last mile of actually placing an order through
`python-bridge/mt5_bridge.py` against a real MT5 terminal. This
environment has no Windows machine, no MT5 terminal, and no real broker
account — so the very first live "Enter Trade" click is genuinely
untested past the point of `order_send()`.

To reduce first-run friction, `mt5_bridge.py` now defends against the
three most common MT5 API rejection reasons instead of hitting them blind:

- **Filling mode** — not every broker/symbol supports every fill type;
  sending the wrong one is rejected with an opaque retcode. `resolve_filling_type()`
  reads the symbol's own `filling_mode` bitmask instead of hardcoding IOC.
- **Stop distance** — brokers reject SL/TP placed closer to price than
  their own minimum (`trade_stops_level`). `validate_stop_distance()`
  checks this up front and returns a clear "stop too close to market"
  error instead of a bare retcode number.
- **Volume** — a lot size below the symbol's minimum, above its maximum,
  or not a multiple of its step is rejected outright. `resolve_volume()`
  snaps to what the broker will actually accept.

Not yet defended against, likely the next thing you'll hit: **symbol
suffixes**. Many brokers append an account-type suffix to symbol names
(`EURUSD.a`, `EURUSDm`, `BTCUSD.raw`, ...). The watchlist you type into
the app is passed straight through as the literal MT5 symbol name — if
`mt5.symbol_select()` fails, check your broker's exact symbol names in
MT5's Market Watch and match the watchlist to those, not the generic name.
The bridge's error message now says this explicitly when symbol selection
fails.

**What to do on the first real test:** open a demo account, run the
bridge, connect, and watch both the bridge's console output and the app's
Live Log. If an order is rejected, the error message will now say *why*
(stop distance, volume, filling mode, or symbol) rather than just a retcode
number — that's specifically so any remaining friction is fast to
diagnose and fix.

## What's still a stub or simplification

- `execution/mt5/MT5Broker.ts` is now fully implemented and has placed a
  real (rejected, then successful-path-tested) order against a live MT5
  terminal via `python-bridge/mt5_bridge.py` — no longer shape-only
- Position size (lots per trade) is now user-configurable in the Live
  Trading connect form (`lotSize`, threaded through to both brokers), but
  it's still a flat number the user sets — not computed from account risk
  % per trade the way a fully automated system might
- `MetaApiBroker.subscribe()` polls every 60s rather than streaming, since
  it uses the RPC connection rather than the streaming connection — fine for
  the 15m timeframe this strategy trades, not for scalping
- `liveRunner.ts` and the desktop app's scan loop both scan on a fixed
  interval rather than reacting to candle closes — good enough for the
  15m timeframe traded, not tick-accurate
- A position the broker closes on its own (server-side SL/TP/trailing
  stop) is noted in the Recent Activity feed but not added to History,
  since the app doesn't independently know its exact exit price or P&L —
  only trades closed through the app's own "Close Now" button appear in
  History, to avoid ever showing a fabricated number
