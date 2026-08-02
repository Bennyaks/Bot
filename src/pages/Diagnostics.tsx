import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  HeartPulse,
  AlertOctagon,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Wifi,
  WifiOff,
  FlaskConical,
  BellRing,
  BellOff,
  Upload,
  Trash2,
  Database,
} from 'lucide-react';
import { PageHeader, Card, Badge, Button } from '../components/ui';
import { useTradingStore } from '../hooks/useTradingStore';
import { INSTRUMENTS } from '../lib/data';
import type { HealthStatus } from '../lib/types';

export default function Diagnostics() {
  const {
    health,
    mode,
    modeReason,
    toggleHealth,
    brokerId,
    brokerConnected,
    toggleBroker,
    forceReconnect,
    runBacktest,
    lastBacktest,
    csvInstruments,
    loadCsvHistory,
    clearCsvHistory,
    desktopAlertsEnabled,
    webhookUrl,
    requestDesktopAlerts,
    disableDesktopAlerts,
    setWebhookUrl,
  } = useTradingStore();
  const [webhookInput, setWebhookInput] = useState(webhookUrl ?? '');
  const [backtestInstrument, setBacktestInstrument] = useState<string>('EURUSD');
  const [csvUploadError, setCsvUploadError] = useState<string | null>(null);

  const handleCsvUpload = (instrument: string, file: File) => {
    setCsvUploadError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const result = loadCsvHistory(instrument, text);
      if (result.candles.length === 0) {
        setCsvUploadError(`Couldn't parse any candles from that file for ${instrument}.`);
      }
    };
    reader.onerror = () => setCsvUploadError('Failed to read the file.');
    reader.readAsText(file);
  };

  const criticalOk = health
    .filter((h) => h.critical)
    .every((h) => h.status === 'healthy' || h.status === 'degraded');

  return (
    <div>
      <PageHeader
        title="Continuous Self Diagnostics"
        subtitle="Monitor system health continuously. If any critical component fails → SAFE MODE → no new trades → alert user."
      />

      <motion.div
        layout
        className={`mb-5 rounded-xl border px-5 py-4 flex flex-wrap items-center justify-between gap-4 ${
          mode === 'SAFE_MODE'
            ? 'border-rose-500/40 bg-rose-500/10'
            : 'border-emerald-500/30 bg-emerald-500/8'
        }`}
      >
        <div className="flex items-center gap-3">
          {mode === 'SAFE_MODE' ? (
            <AlertOctagon className="h-8 w-8 text-rose-400" />
          ) : (
            <HeartPulse className="h-8 w-8 text-emerald-400" />
          )}
          <div>
            <div
              className={`font-display text-lg font-semibold ${
                mode === 'SAFE_MODE' ? 'text-rose-300' : 'text-emerald-300'
              }`}
            >
              System Mode: {mode}
            </div>
            <div className="text-xs text-slate-400 mt-0.5">{modeReason}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={mode === 'SAFE_MODE' ? 'bad' : 'good'}>
            {mode === 'SAFE_MODE' ? 'No New Trades' : 'Trading Enabled'}
          </Badge>
          <Badge tone={criticalOk ? 'good' : 'bad'}>
            Critical {criticalOk ? 'OK' : 'FAIL'}
          </Badge>
        </div>
      </motion.div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
        {health.map((h, i) => (
          <motion.button
            key={h.id}
            type="button"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.04 }}
            onClick={() => toggleHealth(h.id)}
            className={`text-left rounded-xl border p-4 transition-colors ${
              h.status === 'healthy'
                ? 'border-line bg-panel hover:border-emerald-500/30'
                : h.status === 'degraded'
                  ? 'border-amber-500/30 bg-amber-500/5'
                  : 'border-rose-500/40 bg-rose-500/8'
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <StatusIcon status={h.status} />
              <div className="flex flex-col items-end gap-1">
                <Badge
                  tone={
                    h.status === 'healthy' ? 'good' : h.status === 'degraded' ? 'warn' : 'bad'
                  }
                >
                  {h.status}
                </Badge>
                {h.critical && <Badge tone="warn">Critical</Badge>}
              </div>
            </div>
            <div className="text-sm font-medium text-white">{h.name}</div>
            <div className="text-[11px] text-slate-500 mt-1 line-clamp-2">{h.message}</div>
            <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-slate-500">
              <span>{h.latencyMs > 0 ? `${h.latencyMs} ms` : 'n/a'}</span>
              <span>tap to fault</span>
            </div>
          </motion.button>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="SAFE MODE Protocol">
          <div className="p-5 space-y-3">
            {[
              'Detect critical failure (API, Broker, DB, Clock, Market Feed)',
              'Flip system mode to SAFE_MODE',
              'Cancel pending non-filled signals',
              'Block Execution Engine from new orders',
              'Keep open positions managed (stops still live)',
              'Alert user via log stream + UI banner',
              'Resume LIVE only after all critical components healthy',
            ].map((step, i) => (
              <div key={step} className="flex items-start gap-3">
                <div className="h-6 w-6 rounded-full border border-line bg-surface flex items-center justify-center text-[10px] font-mono text-slate-400 shrink-0">
                  {i + 1}
                </div>
                <p className="text-sm text-slate-300 pt-0.5">{step}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Monitored Surfaces">
          <div className="p-5 grid grid-cols-2 gap-2">
            {[
              'API Connection',
              'Broker Connection',
              'Database',
              'Memory',
              'CPU',
              'Clock Synchronization',
              'Logging',
              'Market Data Feed',
            ].map((name) => {
              const comp = health.find((h) => h.name === name);
              return (
                <div
                  key={name}
                  className="rounded-lg border border-line bg-surface/50 px-3 py-2.5 flex items-center justify-between"
                >
                  <span className="text-xs text-slate-300">{name}</span>
                  <StatusIcon status={comp?.status ?? 'healthy'} small />
                </div>
              );
            })}
          </div>
          <div className="px-5 pb-5">
            <Button
              variant="ghost"
              onClick={() => {
                health.forEach((h) => {
                  if (h.status !== 'healthy') toggleHealth(h.id);
                });
              }}
            >
              Restore All Healthy
            </Button>
          </div>
        </Card>
      </div>
      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card title="Broker & Execution (Phase 13)">
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-line bg-surface/50 px-3 py-2.5">
              <div className="flex items-center gap-2">
                {brokerConnected ? (
                  <Wifi className="h-4 w-4 text-emerald-400" />
                ) : (
                  <WifiOff className="h-4 w-4 text-rose-400" />
                )}
                <span className="text-xs font-mono text-slate-300">{brokerId}</span>
              </div>
              <Badge tone={brokerConnected ? 'good' : 'bad'}>{brokerConnected ? 'Connected' : 'Disconnected'}</Badge>
            </div>
            <p className="text-[11px] text-slate-500">
              SystemOrchestrator.setBroker/setExecution swap the live Broker and ExecutionProvider at
              runtime — PaperBroker and the simulated MT5 bridge adapter satisfy the exact same
              interfaces, so this is a dependency swap, not a rewrite.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={toggleBroker}>
                Switch to {brokerId.startsWith('paper') ? 'MT5 (simulated)' : 'Paper Broker'}
              </Button>
              <Button variant="ghost" onClick={forceReconnect}>
                Force Reconnect
              </Button>
            </div>
          </div>
        </Card>

        <Card title="Backtest Harness (Phase 14)">
          <div className="p-5 space-y-4">
            <p className="text-[11px] text-slate-500">
              Runs BreakoutStrategy through the same DecisionEngine and RiskManager instances the live
              pipeline uses — over real uploaded price history when one is loaded for the selected
              instrument, otherwise a freshly generated synthetic series. Every fill is sized against a
              real $10,000 equity curve (PositionSizer), not a fixed lot. A strategy that only ever sees a
              synthetic random walk never gets exercised against real ranging periods, spikes, or
              liquidity sweeps — that's what CSV history is for.
            </p>

            <div className="flex items-center gap-2">
              <select
                value={backtestInstrument}
                onChange={(e) => setBacktestInstrument(e.target.value)}
                className="rounded-md border border-line bg-surface/60 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-accent/50"
              >
                {INSTRUMENTS.map((sym) => (
                  <option key={sym} value={sym}>
                    {sym} {csvInstruments.includes(sym) ? '(real history loaded)' : ''}
                  </option>
                ))}
              </select>
              <Button variant="primary" onClick={() => runBacktest(backtestInstrument)}>
                <FlaskConical className="h-3.5 w-3.5" />
                Run Backtest
              </Button>
            </div>

            <div className="rounded-lg border border-line bg-surface/50 px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <Database className="h-3.5 w-3.5 text-slate-500" />
                  Historical data for {backtestInstrument}
                </div>
                <Badge tone={csvInstruments.includes(backtestInstrument) ? 'good' : 'warn'}>
                  {csvInstruments.includes(backtestInstrument) ? 'Real CSV loaded' : 'Synthetic (no CSV)'}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex-1">
                  <span className="sr-only">Upload CSV for {backtestInstrument}</span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleCsvUpload(backtestInstrument, file);
                      e.target.value = '';
                    }}
                    className="block w-full text-[11px] text-slate-400 file:mr-2 file:rounded-md file:border-0 file:bg-accent/20 file:px-2.5 file:py-1.5 file:text-[11px] file:text-accent-200 hover:file:bg-accent/30"
                  />
                </label>
                {csvInstruments.includes(backtestInstrument) && (
                  <Button variant="ghost" onClick={() => clearCsvHistory(backtestInstrument)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear
                  </Button>
                )}
              </div>
              <p className="text-[10px] text-slate-600">
                CSV with a header row (time/date, open, high, low, close[, volume]) or plain
                time,open,high,low,close columns — MT5, TradingView, and most data-vendor exports work
                directly. <Upload className="inline h-3 w-3 -mt-0.5" /> uploads and parses locally in the
                browser; nothing is sent anywhere.
              </p>
              {csvUploadError && <p className="text-[11px] text-rose-400">{csvUploadError}</p>}
            </div>

            {lastBacktest && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <MiniStat label="Instrument" value={lastBacktest.instrument} />
                <MiniStat label="Data Source" value={lastBacktest.dataSource === 'csv' ? 'Real CSV' : 'Synthetic'} />
                <MiniStat label="Trades" value={String(lastBacktest.trades)} />
                <MiniStat label="Win Rate" value={`${lastBacktest.winRate}%`} />
                <MiniStat label="Profit Factor" value={lastBacktest.profitFactor.toFixed(2)} />
                <MiniStat
                  label="Net P&L"
                  value={`${lastBacktest.netProfitUsd >= 0 ? '+' : ''}$${lastBacktest.netProfitUsd.toFixed(2)}`}
                />
                <MiniStat label="Final Equity" value={`$${lastBacktest.finalEquity.toFixed(2)}`} />
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card title="Alerts Beyond the Log Stream">
          <div className="p-5 space-y-4">
            <p className="text-[11px] text-slate-500">
              The Decision Log Stream only shows what's on screen right now. These channels fire
              independently for ERROR/SAFETY-level events (e.g. a SAFE_MODE trip) so a problem doesn't go
              unnoticed just because the tab isn't in focus.
            </p>
            <div className="flex items-center justify-between rounded-lg border border-line bg-surface/50 px-3 py-2.5">
              <div className="flex items-center gap-2">
                {desktopAlertsEnabled ? (
                  <BellRing className="h-4 w-4 text-emerald-400" />
                ) : (
                  <BellOff className="h-4 w-4 text-slate-500" />
                )}
                <span className="text-xs text-slate-300">Desktop notifications</span>
              </div>
              {desktopAlertsEnabled ? (
                <Button variant="ghost" onClick={disableDesktopAlerts}>
                  Disable
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => requestDesktopAlerts()}>
                  Enable
                </Button>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-[11px] text-slate-500" htmlFor="webhook-url">
                Webhook URL (e.g. a Slack incoming webhook or ntfy.sh topic)
              </label>
              <div className="flex gap-2">
                <input
                  id="webhook-url"
                  type="text"
                  value={webhookInput}
                  onChange={(e) => setWebhookInput(e.target.value)}
                  placeholder="https://hooks.example.com/…"
                  className="flex-1 rounded-md border border-line bg-surface/60 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-accent/50"
                />
                <Button variant="ghost" onClick={() => setWebhookUrl(webhookInput)}>
                  Save
                </Button>
              </div>
              {webhookUrl && <div className="text-[11px] text-emerald-400">Webhook configured</div>}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="font-mono text-sm text-white mt-0.5">{value}</div>
    </div>
  );
}

function StatusIcon({ status, small }: { status: HealthStatus; small?: boolean }) {
  const cls = small ? 'h-3.5 w-3.5' : 'h-5 w-5';
  if (status === 'healthy') return <CheckCircle2 className={`${cls} text-emerald-400`} />;
  if (status === 'degraded') return <AlertTriangle className={`${cls} text-amber-400`} />;
  return <XCircle className={`${cls} text-rose-400`} />;
}
