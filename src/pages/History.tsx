import { useEffect, useState } from 'react';
import { PageHeader, Card, Badge, Stat, EmptyRow } from '../components/ui';
import { TradeAnalytics } from '../core/analytics/Analytics';
import type { ExecutedTrade } from '../lib/types';

function DesktopOnlyNotice() {
  return (
    <div>
      <PageHeader title="History" subtitle="Your closed trades — profit, instrument, and outcome for each." />
      <Card className="p-6">
        <p className="text-sm text-slate-300">This page shows your real trade history from the desktop app — it doesn't work in a browser tab.</p>
      </Card>
    </div>
  );
}

function durationLabel(openedAt: string, closedAt?: string): string {
  if (!closedAt) return '—';
  const minutes = Math.round((new Date(closedAt).getTime() - new Date(openedAt).getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

const analytics = new TradeAnalytics();

export default function History() {
  const [available] = useState(() => typeof window !== 'undefined' && !!window.mt5);
  const [trades, setTrades] = useState<ExecutedTrade[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!available || !window.mt5) return;
    let cancelled = false;
    const load = () => {
      window.mt5!
        .history()
        .then((h) => {
          if (!cancelled) {
            setTrades(h);
            setLoaded(true);
          }
        })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [available]);

  if (!available) return <DesktopOnlyNotice />;

  const closed = trades.filter((t) => t.status !== 'OPEN');
  const wins = closed.filter((t) => t.status === 'WIN').length;
  const losses = closed.filter((t) => t.status === 'LOSS').length;

  return (
    <div>
      <PageHeader
        title="History"
        subtitle="Every trade this app has closed for you, most recent first. Profit is shown in R — how many times your risk on that trade you made or lost, the same measure used everywhere else in the app."
      />

      {closed.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-4 mb-6">
          <Stat label="Trades Closed" value={String(closed.length)} />
          <Stat label="Win Rate" value={`${analytics.winRate(closed)}%`} sub={`${wins}W / ${losses}L`} />
          <Stat label="Profit Factor" value={analytics.profitFactor(closed).toFixed(2)} />
          <Stat
            label="Average Result"
            value={`${analytics.expectancy(closed) >= 0 ? '+' : ''}${analytics.expectancy(closed)}R`}
            tone={analytics.expectancy(closed) >= 0 ? 'good' : 'bad'}
          />
        </div>
      )}

      <Card title="Closed Trades">
        {!loaded ? (
          <EmptyRow text="Loading…" />
        ) : closed.length === 0 ? (
          <EmptyRow text="No trades closed yet. Once one closes, it'll show up here with its result." />
        ) : (
          <div className="divide-y divide-line">
            {closed.map((t) => (
              <div key={t.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge tone={t.side === 'LONG' ? 'good' : 'bad'}>{t.side === 'LONG' ? 'Buy' : 'Sell'}</Badge>
                    <span className="font-mono text-sm text-white">{t.instrument}</span>
                    <Badge tone={t.status === 'WIN' ? 'good' : t.status === 'LOSS' ? 'bad' : 'neutral'}>
                      {t.status === 'WIN' ? 'Win' : t.status === 'LOSS' ? 'Loss' : 'Breakeven'}
                    </Badge>
                    {t.pnlR !== undefined && (
                      <span className={`font-mono text-sm ${t.pnlR >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {t.pnlR >= 0 ? '+' : ''}
                        {t.pnlR.toFixed(2)}R
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    {new Date(t.timestamp).toLocaleString()} · open for {durationLabel(t.timestamp, t.exitTime)} · {t.lotSize} lots
                  </div>
                </div>
                <div className="text-xs text-right">
                  <div>
                    <span className="text-slate-500">Entry </span>
                    <span className="font-mono text-slate-300">{t.entry.toFixed(5)}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Exit </span>
                    <span className="font-mono text-slate-300">{t.exitPrice ? t.exitPrice.toFixed(5) : '—'}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
