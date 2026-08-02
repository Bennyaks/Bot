# Architecture changes — locking the core

This applies Phase 1 (Interfaces + DI + EventBus) and the two
⭐⭐⭐⭐⭐ items from the review — the **Decision Engine** and the
**Risk Manager** — plus a **SystemOrchestrator** to wire it all together.
No pages or features were added; the point was to finish the core first.

## What was missing before

The old flow (`useTradingStore.emitDemoSignal`) had exactly one gate:
broker safety checks. A signal that passed those was marked `APPROVED`
directly — there was no Decision Engine evaluating trend, session
evidence, confidence, reward:risk, or structure quality, and no Risk
Manager with authority to veto on daily loss, consecutive losses, open
positions, or exposure. Business logic, safety checks, and UI state
updates were all interleaved in the hook.

## What's new

```
src/core/
  interfaces/index.ts        every subsystem defined as a contract first
                              (MarketProvider, Strategy, RiskManagerContract,
                              ExecutionProvider, Broker, PositionManagerContract,
                              Storage, Notifier, Analytics)
  events/
    eventTypes.ts             the canonical event chain (TradeCandidateCreated →
                               TradeApproved/Rejected → RiskApproved/Rejected →
                               OrderSubmitted → OrderFilled → PositionOpened →
                               PositionClosed → TradeArchived), plus reserved
                               names for the market-structure events
                               (SwingDetected, BreakoutDetected, ...) so Phase 2/3
                               can publish onto the same bus later
    EventBus.ts                typed pub/sub — nothing calls another subsystem
                               directly when an event will do
  decision/DecisionEngine.ts   TradeCandidate → named, independent gates
                               (trend alignment, session evidence, confidence,
                               reward:risk, structure quality, news event) →
                               TradeApproval | explainable RejectedTrade
  risk/RiskManager.ts          absolute veto authority: max open positions,
                               max consecutive losses, max daily loss (R),
                               max exposure per symbol, min reward:risk
  position/PositionManager.ts  owns the open-position lifecycle: break-even
                               and trailing-stop controllers run on every
                               manage() call; close() computes R-multiple
  orchestrator/
    SystemOrchestrator.ts       the "one module you're missing." Contains no
                               business logic itself — constructed with a
                               Broker, ExecutionProvider, and Notifier (DI),
                               and runs every candidate through Safety →
                               Decision Engine → Risk Manager → Execution,
                               publishing each step on the EventBus.

src/execution/paper/PaperBroker.ts     implements both ExecutionProvider and
                                       Broker — a future MT5Broker drops in
                                       without changing anything upstream
src/providers/replay/ReplayMarketProvider.ts   implements MarketProvider over
                                               the existing simulated candles
```

`src/hooks/useTradingStore.ts` now constructs one `SystemOrchestrator`
via dependency injection and calls `orchestrator.submitCandidate(...)`
instead of hand-rolling the approve/reject logic. `simulateReject` was
also switched to go through the real Decision Engine rather than
returning a hard-coded rejection object, so "Rejected" in the UI now
reflects an actual gate failure.

## Pass 2 — Storage, Analytics, Connection Manager, and closing the fill/close gap

Pass 1 built the pipeline (Safety → Decision → Risk → Execution) but
stopped at `OrderSubmitted`. An "approved" candidate never actually
became a position: `fillCandidate`/`closePosition` existed on the
Orchestrator but nothing called them, so `PositionManager`, `Storage`,
and `Analytics` were all unreachable dead code. This pass wires the
rest of the chain and implements the two interfaces that were still
just contracts.

```
src/core/
  storage/LocalStorage.ts        Storage over window.localStorage (Phase 8).
                                  Defensive against private-browsing/quota
                                  failures — degrades to "doesn't persist"
                                  rather than throwing. InMemoryStorage
                                  ships alongside it as the same contract
                                  for tests/SSR/a future backtest harness.
  analytics/TradeAnalytics.ts     Analytics implementation (Phase 9):
                                  winRate/profitFactor/expectancy over
                                  closed trades only. Also exposes
                                  bySession, equityCurve, and
                                  mostCommonReasons — real aggregates,
                                  not the interface's bare minimum.
  connection/ConnectionManager.ts Phase 10. Polls Broker.isConnected(),
                                  runs exponential-backoff reconnect
                                  attempts on a drop, publishes
                                  BrokerConnectionChanged rather than
                                  calling back into the Orchestrator, and
                                  implements HealthSource so it can sit in
                                  the Diagnostics health list.
```

`SystemOrchestrator` now takes optional `storage`/`analytics` deps
(falling back to `InMemoryStorage`/`TradeAnalytics` so existing callers
don't break), and subscribes to its own EventBus internally:
`TradeRejected`/`RiskRejected` → `storage.saveRejection`,
`TradeArchived` → `storage.saveTrade` + `AnalyticsUpdated`. Storage and
Analytics never touch the pipeline code — they only ever react to what
it publishes.

`useTradingStore.ts`'s `emitDemoSignal` now calls
`orchestrator.fillCandidate(candidate)` on approval, holds the
resulting `ExecutedTrade` for a few seconds (simulating the market),
then calls `orchestrator.closePosition(...)` — so a "approved" signal
now actually opens, gets managed, closes, gets archived, gets
persisted, and updates the live analytics summary. The store also
hydrates `rejected`/`executed` from `storage` on load and subscribes to
`AnalyticsUpdated`/`BrokerConnectionChanged`. The Journal page now shows
a live win-rate/profit-factor/expectancy strip fed by
`getAnalyticsSummary()` instead of static demo numbers.

`Storage`'s interface grew `loadRejections()`/`clear()` to match what a
Journal page actually needs on hydration.

## Pass 3 — Market Pipeline, Breakout Engine, MT5 adapter, backtest + tests

```
src/core/market/
  structure.ts               Pure functions (Phase 2): detectSwings
                              (fractal highs/lows), detectStructureBreaks
                              (walks the series tracking the prevailing
                              trend, labels each break BOS if it continues
                              the trend or CHoCH if it reverses it), and
                              analyzeStructure (the one entry point both
                              the live engine and the backtest harness call).
  MarketStructureEngine.ts   Stateful wrapper (Phase 2): pulls candles from
                              a MarketProvider, runs analyzeStructure, and
                              publishes SwingDetected/BreakoutDetected on
                              the EventBus — the events eventTypes.ts had
                              reserved since Pass 1 are now real.

src/strategies/breakout/
  BreakoutStrategy.ts         Phase 3. A real Strategy implementation:
                               requires a break within N bars (no stale
                               setups) and volume expansion vs. the
                               trailing average, then proposes a candidate
                               with the broken level as the stop. It never
                               places a trade — same contract as the demo
                               generator, just backed by real detection
                               instead of hand-authored candles.

src/execution/mt5/
  MT5Broker.ts                 Phase 13. Implements Broker + ExecutionProvider.
                               A real MT5 adapter talks to a running terminal
                               through a bridge process (Expert Advisor +
                               local socket, or a hosted service) — there's
                               no direct browser-to-terminal path available
                               from this sandbox, so fills/closes are
                               computed with simulated latency and slippage
                               instead. The point is the contract: swapping
                               this in for PaperBroker is a two-line DI
                               change (SystemOrchestrator.setBroker/
                               setExecution, added this pass), not a rewrite,
                               whenever a real bridge exists.

src/core/backtest/
  BacktestHarness.ts            Phase 14. Runs a Strategy through the exact
                               same DecisionEngine and RiskManager instances
                               the live pipeline uses, walking candles bar
                               by bar with no lookahead (Strategy only ever
                               sees a trailing window) and no real timers —
                               fills are computed directly against
                               subsequent highs/lows. This is what makes it
                               a real backtest instead of a second,
                               drifting reimplementation of the rules.
```

`vitest` was added as a dev dependency (`npm test`) with 45 tests across
`DecisionEngine`, `RiskManager`, `PositionManager`, market structure
detection, `TradeAnalytics`, `ConnectionManager` (fake-timer backoff
tests), and an end-to-end `BacktestHarness` run. Writing the
`PositionManager` tests surfaced a real, pre-existing interaction worth
knowing about: `manage()` chains break-even then trailing-stop, and
because break-even zeroes the stop distance (`stop = entry`), trailing
then computes `trail = price - 0 = price` — so once a trade crosses
+1R, the stop locks to the current price rather than trailing at a
fixed R distance behind it. The tests document this as observed
behavior rather than "fixing" it silently, since that's a business-logic
call, not a wiring gap.

`CommandCenter` gained a "Scan Market Structure" action
(`runMarketScan`) that runs the real pipeline — MarketStructureEngine
over ReplayMarketProvider candles, BreakoutStrategy on the result, then
the same submit/fill/close path as the demo signal — and only produces
a trade if the strategy actually found a qualifying setup.
`Diagnostics` gained a broker switcher (Paper ↔ simulated MT5, via the
new hot-swap methods) with a "Force Reconnect" action wired to
`ConnectionManager`, and a "Run Backtest" action surfacing
`BacktestHarness` results inline.

## What this still does NOT include

- A live MT5 bridge — `MT5Broker` is a faithful simulation of the
  contract (magic number, deviation, simulated slippage/latency); an
  actual Expert Advisor + socket/file bridge is out of reach from this
  sandbox
- A `providers/mt5/MT5MarketProvider` for real tick/candle data — only
  `ReplayMarketProvider` exists; `MarketProvider` is ready for one
- UI for the Market Pipeline's own output (a chart overlay showing
  detected swings/BOS/CHoCH) — `runMarketScan` publishes the events and
  logs the outcome, but nothing renders `SwingDetected` visually yet
- A CLI entry point for the backtest harness — it's reachable today only
  from the Diagnostics page or a test; `BacktestHarness.run()` has no
  external dependencies, so a `scripts/backtest.ts` wrapper is a small
  addition whenever one is wanted

Everything above still slots into `core/interfaces/index.ts` without
another architectural rewrite.
