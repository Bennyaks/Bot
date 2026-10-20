import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader, Card, Badge, Button, Stat, EmptyRow } from '../components/ui';
import { translateBrokerError, friendlyLogMessage, humanTimeframe } from '../lib/friendlyError';
import type { MT5PendingCandidate, MT5Status, MT5LivePosition } from '../types/electron';
import type { LogEntry } from '../lib/types';

const LS_MODE_KEY = 'live-trading:mode';
const LS_TOKEN_KEY = 'live-trading:metaapi-token';
const LS_ACCOUNT_KEY = 'live-trading:metaapi-account-id';
const LS_BRIDGE_URL_KEY = 'live-trading:mt5-bridge-url';
const LS_WATCHLIST_KEY = 'live-trading:watchlist';
const LS_LOT_SIZE_KEY = 'live-trading:lot-size';
const LS_SIZING_MODE_KEY = 'live-trading:sizing-mode';
const LS_RISK_PERCENT_KEY = 'live-trading:risk-percent';

type ConnectMode = 'metaapi' | 'mt5-local';

function DesktopOnlyNotice() {
  return (
    <div>
      <PageHeader
        title="Live Trading"
        subtitle="Connect to a real MT5 account and trade with your go-ahead on every entry."
      />
      <Card className="p-6">
        <p className="text-sm text-slate-300">
          This page talks directly to your MT5 account, which requires the desktop app — it doesn't
          work in a browser tab.
        </p>
        <p className="mt-3 text-sm text-slate-400">
          Open the installed desktop app to connect and trade.
        </p>
      </Card>
    </div>
  );
}

function elapsedLabel(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
}

export default function LiveTrading() {
  const [available] = useState(() => typeof window !== 'undefined' && !!window.mt5);

  const [status, setStatus] = useState<MT5Status>({
    connected: false,
    connectionStatus: 'idle',
    equity: 0,
    broker: null,
    lotSize: 0.01,
    riskPercent: null,
  });
  const [activity, setActivity] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<MT5PendingCandidate[]>([]);
  // User-adjusted stop-loss/take-profit per pending candidate, keyed by candidate id.
  // Pre-filled with the strategy's own numbers; the user can widen or tighten either
  // one before entering. Cleared once a candidate is responded to or expires.
  const [slTpEdits, setSlTpEdits] = useState<Record<string, { stop: number; target: number }>>({});
  const [positions, setPositions] = useState<MT5LivePosition[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [execError, setExecError] = useState<{ title: string; message: string; raw: string } | null>(null);
  const [showRawError, setShowRawError] = useState(false);

  const [mode, setMode] = useState<ConnectMode>(
    () => (localStorage.getItem(LS_MODE_KEY) as ConnectMode | null) ?? 'mt5-local'
  );
  const [token, setToken] = useState(() => localStorage.getItem(LS_TOKEN_KEY) ?? '');
  const [accountId, setAccountId] = useState(() => localStorage.getItem(LS_ACCOUNT_KEY) ?? '');
  const [bridgeUrl, setBridgeUrl] = useState(
    () => localStorage.getItem(LS_BRIDGE_URL_KEY) ?? 'http://localhost:8787'
  );
  const [watchlist, setWatchlist] = useState(
    () => localStorage.getItem(LS_WATCHLIST_KEY) ?? 'EURUSD,GBPUSD,USDJPY'
  );
  const [lotSize, setLotSize] = useState(() => Number(localStorage.getItem(LS_LOT_SIZE_KEY)) || 0.01);
  // 'fixed' = always the same lot size; 'risk' = size sized per-trade off equity and that
  // trade's own stop distance (see core/risk/PositionSizer.ts) — a wider stop gets fewer lots.
  const [sizingMode, setSizingMode] = useState<'fixed' | 'risk'>(
    () => (localStorage.getItem(LS_SIZING_MODE_KEY) as 'fixed' | 'risk' | null) ?? 'fixed'
  );
  const [riskPercent, setRiskPercent] = useState(() => Number(localStorage.getItem(LS_RISK_PERCENT_KEY)) || 1);
  const [pollSeconds, setPollSeconds] = useState(60);

  const respondedRef = useRef(new Set<string>());

  useEffect(() => {
    if (!available || !window.mt5) return;
    const mt5 = window.mt5;

    mt5.onStatus((s) => setStatus(s));
    mt5.onLog((entry) => setActivity((prev) => [entry, ...prev].slice(0, 200)));
    mt5.onCandidate((candidate) => {
      if (respondedRef.current.has(candidate.id)) return;
      setPending((prev) => (prev.some((c) => c.id === candidate.id) ? prev : [candidate, ...prev]));
      setSlTpEdits((prev) =>
        prev[candidate.id] ? prev : { ...prev, [candidate.id]: { stop: candidate.stop, target: candidate.target } }
      );
    });
    mt5.onCandidateExpired((candidateId) => {
      // The bot cleared this recommendation itself after nobody acted on it
      // in time — drop the card rather than leaving it sitting there
      // looking actionable against a price that's likely moved on.
      setPending((prev) => prev.filter((c) => c.id !== candidateId));
      setSlTpEdits((prev) => {
        const { [candidateId]: _drop, ...rest } = prev;
        return rest;
      });
    });
    mt5.onPositions((next) => setPositions(next));

    mt5.status().then(setStatus).catch(() => {});
    mt5.positions().then(setPositions).catch(() => {});

    return () => mt5.removeAllListeners();
  }, [available]);

  const handleConnect = useCallback(async () => {
    if (!window.mt5) return;

    if (mode === 'metaapi' && (!token.trim() || !accountId.trim())) {
      setFormError('Token and account id are both required.');
      return;
    }
    if (mode === 'mt5-local' && !bridgeUrl.trim()) {
      setFormError('Bridge URL is required.');
      return;
    }

    setFormError(null);
    setExecError(null);
    setConnecting(true);
    localStorage.setItem(LS_MODE_KEY, mode);
    localStorage.setItem(LS_WATCHLIST_KEY, watchlist);
    localStorage.setItem(LS_LOT_SIZE_KEY, String(lotSize));
    localStorage.setItem(LS_SIZING_MODE_KEY, sizingMode);
    localStorage.setItem(LS_RISK_PERCENT_KEY, String(riskPercent));
    if (mode === 'metaapi') {
      localStorage.setItem(LS_TOKEN_KEY, token);
      localStorage.setItem(LS_ACCOUNT_KEY, accountId);
    } else {
      localStorage.setItem(LS_BRIDGE_URL_KEY, bridgeUrl);
    }

    try {
      const watchlistArr = watchlist.split(',').map((s) => s.trim()).filter(Boolean);
      const sizingArgs = sizingMode === 'risk' ? { riskPercent: riskPercent / 100 } : { lotSize };
      const result = await window.mt5.connect(
        mode === 'metaapi'
          ? { mode, token: token.trim(), accountId: accountId.trim(), watchlist: watchlistArr, pollSeconds, ...sizingArgs }
          : { mode, bridgeUrl: bridgeUrl.trim(), watchlist: watchlistArr, pollSeconds, ...sizingArgs }
      );
      setStatus(result);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [mode, token, accountId, bridgeUrl, watchlist, lotSize, sizingMode, riskPercent, pollSeconds]);

  const handleDisconnect = useCallback(async () => {
    if (!window.mt5) return;
    await window.mt5.disconnect();
    setPending([]);
    setPositions([]);
  }, []);

  const respond = useCallback(
    async (candidateId: string, approve: boolean) => {
      if (!window.mt5) return;
      const candidate = pending.find((c) => c.id === candidateId);
      const edit = slTpEdits[candidateId];
      respondedRef.current.add(candidateId);
      setPending((prev) => prev.filter((c) => c.id !== candidateId));
      setExecError(null);
      try {
        if (approve) {
          const overrides =
            edit && candidate && (edit.stop !== candidate.stop || edit.target !== candidate.target)
              ? { stop: edit.stop, target: edit.target }
              : undefined;
          await window.mt5.approve(candidateId, overrides);
        } else {
          await window.mt5.skip(candidateId);
        }
        setSlTpEdits((prev) => {
          const { [candidateId]: _drop, ...rest } = prev;
          return rest;
        });
      } catch (err) {
        respondedRef.current.delete(candidateId);
        if (candidate) setPending((prev) => [candidate, ...prev]);
        const rawMessage = err instanceof Error ? err.message : String(err);
        setExecError(translateBrokerError(rawMessage));
        setShowRawError(false);
      }
    },
    [pending, slTpEdits]
  );

  const closePosition = useCallback(async (tradeId: string) => {
    if (!window.mt5) return;
    setExecError(null);
    try {
      await window.mt5.closePosition(tradeId);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      setExecError(translateBrokerError(rawMessage));
      setShowRawError(false);
    }
  }, []);

  if (!available) return <DesktopOnlyNotice />;

  return (
    <div>
      <PageHeader
        title="Live Trading"
        subtitle="Every trade that clears every check waits for your go-ahead below — nothing is sent to your broker automatically."
        actions={
          status.connected ? (
            <Button variant="danger" onClick={handleDisconnect}>
              Disconnect
            </Button>
          ) : undefined
        }
      />

      {!status.connected && (
        <Card title="Connect to MT5" className="p-4 mb-6">
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setMode('mt5-local')}
              className={`flex-1 rounded-md border px-3 py-2 text-sm text-left transition-colors ${
                mode === 'mt5-local' ? 'border-accent/60 bg-accent/10 text-white' : 'border-line text-slate-400 hover:text-slate-200'
              }`}
            >
              <div className="font-medium">Local MT5 + Python</div>
              <div className="text-[11px] text-slate-500 mt-0.5">Free, no account/token. Needs the MT5 terminal + bridge running on this PC.</div>
            </button>
            <button
              onClick={() => setMode('metaapi')}
              className={`flex-1 rounded-md border px-3 py-2 text-sm text-left transition-colors ${
                mode === 'metaapi' ? 'border-accent/60 bg-accent/10 text-white' : 'border-line text-slate-400 hover:text-slate-200'
              }`}
            >
              <div className="font-medium">MetaApi.cloud</div>
              <div className="text-[11px] text-slate-500 mt-0.5">Cloud-hosted terminal — keeps trading/trailing even if this PC is off.</div>
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {mode === 'metaapi' ? (
              <>
                <label className="text-xs text-slate-400 space-y-1">
                  <span>MetaApi token</span>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="from app.metaapi.cloud/token"
                    className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent/50"
                  />
                </label>
                <label className="text-xs text-slate-400 space-y-1">
                  <span>MetaApi account id</span>
                  <input
                    type="text"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    placeholder="from app.metaapi.cloud/accounts"
                    className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent/50"
                  />
                </label>
              </>
            ) : (
              <label className="text-xs text-slate-400 space-y-1 sm:col-span-2">
                <span>Bridge URL</span>
                <input
                  type="text"
                  value={bridgeUrl}
                  onChange={(e) => setBridgeUrl(e.target.value)}
                  placeholder="http://localhost:8787"
                  className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent/50"
                />
              </label>
            )}
            <label className="text-xs text-slate-400 space-y-1">
              <span>Instruments to watch (comma-separated)</span>
              <input
                type="text"
                value={watchlist}
                onChange={(e) => setWatchlist(e.target.value)}
                className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent/50"
              />
            </label>
            <label className="text-xs text-slate-400 space-y-1">
              <span>How often to check for trades (seconds)</span>
              <input
                type="number"
                min={15}
                value={pollSeconds}
                onChange={(e) => setPollSeconds(Number(e.target.value) || 60)}
                className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent/50"
              />
            </label>
            <div className="text-xs text-slate-400 space-y-1">
              <span>Position sizing</span>
              <div className="flex rounded-md border border-line overflow-hidden text-[13px]">
                <button
                  type="button"
                  onClick={() => setSizingMode('fixed')}
                  className={`flex-1 px-3 py-2 ${sizingMode === 'fixed' ? 'bg-accent/20 text-accent' : 'bg-surface text-slate-400 hover:text-slate-200'}`}
                >
                  Fixed lot size
                </button>
                <button
                  type="button"
                  onClick={() => setSizingMode('risk')}
                  className={`flex-1 px-3 py-2 border-l border-line ${sizingMode === 'risk' ? 'bg-accent/20 text-accent' : 'bg-surface text-slate-400 hover:text-slate-200'}`}
                >
                  Risk % per trade
                </button>
              </div>
              {sizingMode === 'fixed' ? (
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={lotSize}
                  onChange={(e) => setLotSize(Number(e.target.value) || 0.01)}
                  className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent/50"
                  placeholder="Lots per trade"
                />
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={riskPercent}
                      onChange={(e) => setRiskPercent(Number(e.target.value) || 1)}
                      className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent/50"
                    />
                    <span className="text-slate-500 shrink-0">% of equity per trade</span>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Every trade risks the same % of your account regardless of stop distance — a wider stop gets fewer
                    lots, a tighter stop gets more. A flat lot size across different stop widths risks a different
                    dollar amount every time, which quietly breaks the R-multiple math elsewhere in this app.
                  </p>
                </>
              )}
            </div>
          </div>

          {mode === 'mt5-local' ? (
            <p className="mt-3 text-[11px] text-slate-500">
              Before connecting: open your MT5 terminal, log into your account (demo while testing), then run
              the bridge program. Nothing is sent anywhere except your own MT5 terminal — everything stays on
              this machine.
            </p>
          ) : (
            <p className="mt-3 text-[11px] text-slate-500">
              Your token and account id are saved only on this machine — never sent anywhere except to
              MetaApi.cloud when you connect. Use a demo account while testing.
            </p>
          )}
          {formError && <p className="mt-2 text-sm text-rose-400">{formError}</p>}
          <div className="mt-4">
            <Button onClick={handleConnect} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </Card>
      )}

      {execError && (
        <Card className="mb-6 border-rose-500/30">
          <div className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-rose-300">{execError.title}</div>
                <p className="mt-1 text-sm text-rose-200/90">{execError.message}</p>
                <button
                  onClick={() => setShowRawError((v) => !v)}
                  className="mt-2 text-[11px] text-slate-500 hover:text-slate-300 underline underline-offset-2"
                >
                  {showRawError ? 'Hide' : 'Show'} technical details
                </button>
                {showRawError && (
                  <p className="mt-2 text-[11px] text-slate-500 font-mono bg-black/20 rounded p-2">{execError.raw}</p>
                )}
              </div>
              <Button variant="ghost" onClick={() => setExecError(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        </Card>
      )}

      {status.connected && (
        <>
          <div className="grid gap-4 sm:grid-cols-4 mb-6">
            <Stat
              label="Connection"
              value={status.connectionStatus === 'connected' ? 'Connected' : status.connectionStatus.toUpperCase()}
              tone={status.connectionStatus === 'connected' ? 'good' : 'bad'}
            />
            <Stat label="Account Balance" value={`$${status.equity.toFixed(2)}`} />
            <Stat label="Broker" value={status.broker === 'mt5-broker' ? 'MT5 (local)' : status.broker === 'metaapi-broker' ? 'MT5 (MetaApi.cloud)' : (status.broker ?? '—')} />
            <Stat
              label="Position Sizing"
              value={status.riskPercent ? `${(status.riskPercent * 100).toFixed(2)}% risk/trade` : `${status.lotSize} lots`}
            />
          </div>

          {pending.length > 0 && (
            <Card title="Awaiting your go-ahead" className="mb-6">
              <div className="divide-y divide-line">
                {[...pending]
                  .sort((a, b) => a.rank - b.rank)
                  .map((c) => (
                    <div key={c.id} className="p-4 flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {c.rank === 1 && pending.length > 1 && <Badge tone="good">BEST PICK</Badge>}
                          <Badge tone={c.side === 'LONG' ? 'good' : 'bad'}>{c.side === 'LONG' ? 'Buy' : 'Sell'}</Badge>
                          <span className="font-mono text-sm text-white">{c.instrument}</span>
                          <span className="text-xs text-slate-500">{humanTimeframe(c.timeframe)}</span>
                        </div>
                        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
                          <div><span className="text-slate-500">Entry </span><span className="font-mono text-slate-200">{c.entry.toFixed(5)}</span></div>
                          <label className="flex items-center gap-1.5">
                            <span className="text-slate-500 shrink-0">Stop loss</span>
                            <input
                              type="number"
                              step="0.00001"
                              value={slTpEdits[c.id]?.stop ?? c.stop}
                              onChange={(e) => {
                                const value = Number(e.target.value);
                                if (Number.isNaN(value)) return;
                                setSlTpEdits((prev) => ({
                                  ...prev,
                                  [c.id]: { stop: value, target: prev[c.id]?.target ?? c.target },
                                }));
                              }}
                              className="w-24 rounded border border-line bg-surface px-1.5 py-1 font-mono text-rose-300 outline-none focus:border-accent/50"
                            />
                          </label>
                          <label className="flex items-center gap-1.5">
                            <span className="text-slate-500 shrink-0">Take profit</span>
                            <input
                              type="number"
                              step="0.00001"
                              value={slTpEdits[c.id]?.target ?? c.target}
                              onChange={(e) => {
                                const value = Number(e.target.value);
                                if (Number.isNaN(value)) return;
                                setSlTpEdits((prev) => ({
                                  ...prev,
                                  [c.id]: { stop: prev[c.id]?.stop ?? c.stop, target: value },
                                }));
                              }}
                              className="w-24 rounded border border-line bg-surface px-1.5 py-1 font-mono text-emerald-300 outline-none focus:border-accent/50"
                            />
                          </label>
                          <div><span className="text-slate-500">Size </span><span className="font-mono text-slate-200">{c.lotSize} lots</span></div>
                        </div>
                        <div className="mt-2 text-xs text-slate-500">
                          {(() => {
                            const edit = slTpEdits[c.id];
                            const stop = edit?.stop ?? c.stop;
                            const target = edit?.target ?? c.target;
                            const risk = Math.abs(c.entry - stop);
                            const reward = Math.abs(target - c.entry);
                            const rr = risk > 0 ? reward / risk : 0;
                            const edited = stop !== c.stop || target !== c.target;
                            return (
                              <>
                                Confidence {(c.confidence * 100).toFixed(0)}% · Reward is {rr.toFixed(1)}x the risk
                                {edited ? ' (adjusted by you)' : ''}
                              </>
                            );
                          })()}
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500">{c.structure}</div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button variant="primary" onClick={() => respond(c.id, true)}>
                          Enter Trade
                        </Button>
                        <Button variant="ghost" onClick={() => respond(c.id, false)}>
                          Skip
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
              {pending.length > 1 && (
                <p className="px-4 pb-3 text-[11px] text-slate-500">
                  {pending.length} instruments cleared every check this scan — ranked strongest first.
                </p>
              )}
            </Card>
          )}

          <Card title={`Tracking Open Trades (${positions.length})`} className="mb-6">
            {positions.length === 0 ? (
              <EmptyRow text="No open trades right now. Once one fills, you'll see it here — protected by your broker's stop-loss and take-profit immediately." />
            ) : (
              <div className="divide-y divide-line">
                {positions.map((p) => (
                  <div key={p.id} className="p-4 flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge tone={p.side === 'LONG' ? 'good' : 'bad'}>{p.side === 'LONG' ? 'Buy' : 'Sell'}</Badge>
                        <span className="font-mono text-sm text-white">{p.instrument}</span>
                        <span className="text-xs text-slate-500">{elapsedLabel(p.elapsedMinutes)}</span>
                        {p.floatingR !== null && (
                          <Badge tone={p.floatingR >= 0 ? 'good' : 'bad'}>
                            {p.floatingR >= 0 ? '+' : ''}
                            {p.floatingR.toFixed(2)}R so far
                          </Badge>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-x-6 gap-y-1 text-xs">
                        <div><span className="text-slate-500">Entry </span><span className="font-mono text-slate-200">{p.entry.toFixed(5)}</span></div>
                        <div><span className="text-slate-500">Now </span><span className="font-mono text-slate-200">{p.currentPrice ? p.currentPrice.toFixed(5) : '—'}</span></div>
                        <div><span className="text-slate-500">Stop loss </span><span className="font-mono text-rose-300">{p.stop.toFixed(5)}</span></div>
                        <div><span className="text-slate-500">Take profit </span><span className="font-mono text-emerald-300">{p.target.toFixed(5)}</span></div>
                        <div><span className="text-slate-500">Size </span><span className="font-mono text-slate-200">{p.lotSize} lots</span></div>
                      </div>
                    </div>
                    <Button variant="warn" onClick={() => closePosition(p.id)}>
                      Close Now
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Recent Activity">
            {activity.length === 0 ? (
              <EmptyRow text="Waiting for the first check…" />
            ) : (
              <div className="max-h-[360px] overflow-y-auto divide-y divide-line text-xs">
                {activity.map((l) => (
                  <div key={l.id} className="px-4 py-2.5 flex items-start gap-3">
                    <span className="text-slate-600 shrink-0 font-mono">
                      {new Date(l.timestamp).toISOString().slice(11, 19)}
                    </span>
                    {l.level === 'ERROR' && <Badge tone="bad">Problem</Badge>}
                    {l.level === 'REJECT' && <Badge tone="warn">Skipped</Badge>}
                    {l.level === 'TRADE' && <Badge tone="good">Trade</Badge>}
                    <span className="text-slate-300">{friendlyLogMessage(l.level, l.message)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
