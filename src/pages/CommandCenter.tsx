import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  ShieldAlert,
  Activity,
  CheckCircle2,
  Radar,
} from 'lucide-react';
import { PageHeader, Card, Stat, Badge, Button } from '../components/ui';
import CandleChart from '../components/CandleChart';
import { useTradingStore } from '../hooks/useTradingStore';
import { generateCandles, accountStats, pipelineStages } from '../lib/data';
import { formatDateTime, money } from '../lib/engine';
import { Link } from 'react-router-dom';

export default function CommandCenter() {
  const { mode, modeReason, signals, executed, rejected, health, emitDemoSignal, runMarketScan, logs } =
    useTradingStore();
  const candles = useMemo(() => generateCandles(72, 1.0838), []);

  const open = executed.filter((t) => t.status === 'OPEN');
  const healthyCount = health.filter((h) => h.status === 'healthy').length;

  return (
    <div>
      <PageHeader
        title="Command Center"
        subtitle="Event-driven breakout platform — strategy emits signals, risk & execution decide. Capital protection overrides profit."
        actions={
          <>
            <Button onClick={runMarketScan} variant="ghost">
              <Radar className="h-3.5 w-3.5" />
              Scan All Markets
            </Button>
            <Button onClick={emitDemoSignal} variant="primary">
              <Zap className="h-3.5 w-3.5" />
              Emit Signal
            </Button>
            <Link to="/diagnostics">
              <Button variant={mode === 'SAFE_MODE' ? 'danger' : 'ghost'}>
                <ShieldAlert className="h-3.5 w-3.5" />
                Diagnostics
              </Button>
            </Link>
          </>
        }
      />

      {mode === 'SAFE_MODE' && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 flex items-start gap-3"
        >
          <ShieldAlert className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-medium text-rose-300">SAFE MODE ENGAGED</div>
            <div className="text-xs text-rose-300/80 mt-0.5">{modeReason} No new trades will be sent.</div>
          </div>
        </motion.div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3 mb-5">
        <Stat label="Equity" value={money(accountStats.equity)} sub={`Bal ${money(accountStats.balance)}`} />
        <Stat
          label="Day PnL"
          value={`${accountStats.dayPnlR >= 0 ? '+' : ''}${accountStats.dayPnlR.toFixed(2)}R`}
          tone="good"
          sub={money(accountStats.openPnl)}
        />
        <Stat label="Win Rate" value={`${accountStats.winRate}%`} tone="accent" />
        <Stat label="Profit Factor" value={accountStats.profitFactor.toFixed(2)} />
        <Stat label="Open" value={String(open.length)} sub="positions" />
        <Stat
          label="Health"
          value={`${healthyCount}/${health.length}`}
          tone={healthyCount === health.length ? 'good' : 'bad'}
          sub={mode}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <Card title="Live Market · EURUSD 15m" className="lg:col-span-2">
          <div className="p-3">
            <CandleChart candles={candles} height={260} />
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="good">BOS Confirmed</Badge>
              <Badge tone="accent">Volume 1.8×</Badge>
              <Badge tone="info">London Session</Badge>
              <Badge tone="neutral">Regime: TRENDING_BULL</Badge>
              <Badge tone="good">RR 2.0</Badge>
            </div>
          </div>
        </Card>

        <Card title="Signal → Execution Pipeline">
          <div className="p-4 space-y-3">
            {pipelineStages.map((stage, i) => (
              <div key={stage.id} className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div
                    className={`h-7 w-7 rounded-full border flex items-center justify-center text-[10px] font-mono ${
                      stage.status === 'passed'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                        : stage.status === 'active'
                          ? 'border-accent/50 bg-accent/15 text-accent animate-pulse'
                          : stage.status === 'failed'
                            ? 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                            : 'border-line bg-white/3 text-slate-500'
                    }`}
                  >
                    {i + 1}
                  </div>
                  {i < pipelineStages.length - 1 && (
                    <div className="w-px h-4 bg-line my-0.5" />
                  )}
                </div>
                <div className="pt-1 min-w-0">
                  <div className="text-sm text-slate-200 leading-none">{stage.name}</div>
                  <div className="text-[11px] text-slate-500 mt-1">{stage.description}</div>
                </div>
              </div>
            ))}
            <div className="pt-2 border-t border-line text-[11px] text-slate-500">
              Strategy never places trades. It only produces a{' '}
              <span className="text-accent font-mono">TradeSignal</span>.
            </div>
          </div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card
          title="Active Signals"
          action={
            <Badge tone="accent">{signals.length}</Badge>
          }
        >
          <div className="divide-y divide-line max-h-72 overflow-y-auto">
            {signals.slice(0, 6).map((s) => (
              <div key={s.id} className="px-4 py-3 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-white">{s.instrument}</span>
                    <Badge tone={s.side === 'LONG' ? 'good' : 'bad'}>{s.side}</Badge>
                    <Badge
                      tone={
                        s.status === 'EXECUTED' || s.status === 'APPROVED'
                          ? 'good'
                          : s.status === 'REJECTED'
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {s.status}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1">
                    {s.structure} · conf {(s.confidence * 100).toFixed(0)}%
                  </div>
                </div>
                {s.side === 'LONG' ? (
                  <ArrowUpRight className="h-4 w-4 text-emerald-400 shrink-0" />
                ) : (
                  <ArrowDownRight className="h-4 w-4 text-rose-400 shrink-0" />
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card title="Open & Recent Trades">
          <div className="divide-y divide-line max-h-72 overflow-y-auto">
            {executed.slice(0, 5).map((t) => (
              <div key={t.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{t.instrument}</span>
                    <Badge tone={t.side === 'LONG' ? 'good' : 'bad'}>{t.side}</Badge>
                    <Badge
                      tone={
                        t.status === 'WIN' || t.status === 'OPEN'
                          ? 'good'
                          : t.status === 'LOSS'
                            ? 'bad'
                            : 'warn'
                      }
                    >
                      {t.status}
                    </Badge>
                  </div>
                  <span
                    className={`font-mono text-sm ${
                      (t.pnlR ?? 0) > 0
                        ? 'text-emerald-400'
                        : (t.pnlR ?? 0) < 0
                          ? 'text-rose-400'
                          : 'text-slate-400'
                    }`}
                  >
                    {t.pnlR != null
                      ? `${t.pnlR > 0 ? '+' : ''}${t.pnlR.toFixed(2)}R`
                      : '—'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 mt-1 line-clamp-1">{t.explanation}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Rejection Feed"
          action={
            <Link to="/journal" className="text-[11px] text-accent hover:underline">
              Full journal
            </Link>
          }
        >
          <div className="divide-y divide-line max-h-72 overflow-y-auto">
            {rejected.slice(0, 5).map((r) => (
              <div key={r.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{r.instrument}</span>
                    <Badge tone="bad">Rejected</Badge>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono">
                    {formatDateTime(r.timestamp)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {r.reasons.slice(0, 3).map((reason) => (
                    <Badge key={reason} tone="warn">
                      {reason}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card title="System Pulse">
          <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {health.map((h) => (
              <div
                key={h.id}
                className="rounded-lg border border-line bg-surface/60 p-3"
              >
                <div className="flex items-center gap-1.5 mb-1">
                  {h.status === 'healthy' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Activity className="h-3.5 w-3.5 text-rose-400" />
                  )}
                  <span className="text-[11px] text-slate-300 truncate">{h.name}</span>
                </div>
                <div className="font-mono text-[11px] text-slate-500">
                  {h.latencyMs > 0 ? `${h.latencyMs}ms` : 'ok'}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Decision Log Stream">
          <div className="max-h-[200px] overflow-y-auto font-mono text-[11px] divide-y divide-line">
            {logs.slice(0, 8).map((l) => (
              <div key={l.id} className="px-4 py-2 flex gap-3">
                <span className="text-slate-600 shrink-0">
                  {new Date(l.timestamp).toISOString().slice(11, 19)}
                </span>
                <span
                  className={`shrink-0 w-14 ${
                    l.level === 'ERROR' || l.level === 'REJECT'
                      ? 'text-rose-400'
                      : l.level === 'WARN'
                        ? 'text-amber-400'
                        : l.level === 'TRADE' || l.level === 'SAFETY'
                          ? 'text-accent'
                          : 'text-slate-500'
                  }`}
                >
                  {l.level}
                </span>
                <span className="text-slate-300 truncate">{l.message}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
