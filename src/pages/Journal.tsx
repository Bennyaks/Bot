import { useMemo } from 'react';
import { FileWarning, Search } from 'lucide-react';
import { PageHeader, Card, Badge, Button } from '../components/ui';
import { useTradingStore } from '../hooks/useTradingStore';
import { formatDateTime } from '../lib/engine';

export default function Journal() {
  const { rejected, selectedRejectId, selectReject, simulateReject, stats } = useTradingStore();

  const selected = useMemo(
    () => rejected.find((r) => r.id === selectedRejectId) ?? rejected[0],
    [rejected, selectedRejectId]
  );

  return (
    <div>
      <PageHeader
        title="Strategy Journal"
        subtitle="Log every rejected opportunity. Rejected trades are just as valuable as executed trades — they teach the filter."
        actions={
          <Button onClick={simulateReject} variant="warn">
            <FileWarning className="h-3.5 w-3.5" />
            Simulate Rejection
          </Button>
        }
      />

      <div className="grid sm:grid-cols-3 gap-4 mb-4">
        <Card className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">Win Rate</div>
          <div className="text-xl font-mono text-white mt-1">{stats.winRate}%</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">Profit Factor</div>
          <div className="text-xl font-mono text-white mt-1">
            {Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">Expectancy</div>
          <div className="text-xl font-mono text-white mt-1">{stats.expectancy}R</div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-5 gap-4">
        <Card
          className="lg:col-span-2"
          title="Rejected Opportunities"
          action={<Badge tone="bad">{rejected.length}</Badge>}
        >
          <div className="max-h-[640px] overflow-y-auto divide-y divide-line">
            {rejected.map((r) => {
              const active = r.id === selected?.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => selectReject(r.id)}
                  className={`w-full text-left px-4 py-3 transition-colors ${
                    active ? 'bg-accent/8 border-l-2 border-l-accent' : 'hover:bg-white/3 border-l-2 border-l-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-white">{r.instrument}</span>
                    <span className="text-[10px] font-mono text-slate-500">
                      {formatDateTime(r.timestamp)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge tone={r.side === 'LONG' ? 'good' : 'bad'}>{r.side}</Badge>
                    <Badge tone="neutral">{r.session}</Badge>
                    <Badge tone="warn">{r.setupStage}</Badge>
                  </div>
                  <div className="mt-1.5 text-[11px] text-slate-500 line-clamp-1">
                    {r.reasons.join(' · ')}
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        <div className="lg:col-span-3 space-y-4">
          {selected ? (
            <>
              <Card>
                <div className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Search className="h-4 w-4 text-accent" />
                        <span className="text-xs uppercase tracking-wider text-slate-500">
                          Why it did not trade
                        </span>
                      </div>
                      <h2 className="font-display text-xl text-white">
                        {selected.instrument}{' '}
                        <span className="text-slate-500 font-mono text-base">{selected.id}</span>
                      </h2>
                    </div>
                    <Badge tone="bad">Rejected</Badge>
                  </div>

                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <Field label="Timestamp" value={formatDateTime(selected.timestamp)} />
                    <Field label="Instrument" value={selected.instrument} />
                    <Field label="Timeframe" value={selected.timeframe} />
                    <Field label="Side" value={selected.side} />
                    <Field label="Setup Stage" value={selected.setupStage} />
                    <Field label="Market Regime" value={selected.marketRegime} />
                    <Field label="Session" value={selected.session} />
                    <Field
                      label="Confidence"
                      value={`${(selected.confidence * 100).toFixed(0)}%`}
                    />
                  </div>
                </div>
              </Card>

              <Card title="Failed Rule(s)">
                <div className="p-5 flex flex-wrap gap-2">
                  {selected.failedRules.map((rule) => (
                    <span
                      key={rule}
                      className="inline-flex items-center px-3 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-sm text-rose-300"
                    >
                      {rule}
                    </span>
                  ))}
                </div>
              </Card>

              <Card title="Supporting Data">
                <div className="p-5">
                  <div className="grid sm:grid-cols-2 gap-2">
                    {Object.entries(selected.supportingData).map(([k, v]) => (
                      <div
                        key={k}
                        className="flex items-center justify-between rounded-lg border border-line bg-surface/50 px-3 py-2"
                      >
                        <span className="text-[11px] text-slate-500 font-mono">{k}</span>
                        <span className="text-sm font-mono text-slate-200">
                          {typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              <Card title="Narrative Explanation">
                <div className="p-5 text-sm text-slate-300 leading-relaxed">
                  At <span className="font-mono text-accent">{formatDateTime(selected.timestamp)}</span>,
                  a <span className="text-white">{selected.side}</span> setup on{' '}
                  <span className="font-mono text-white">{selected.instrument}</span> ({selected.timeframe})
                  reached stage <span className="font-mono text-amber-300">{selected.setupStage}</span>{' '}
                  under regime <span className="font-mono">{selected.marketRegime}</span>. The engine
                  halted progression because:{' '}
                  <span className="text-rose-300">{selected.reasons.join('; ')}</span>. Confidence was{' '}
                  only {(selected.confidence * 100).toFixed(0)}%, below the live threshold. No order was
                  constructed. This rejection is immutable and versioned against strategy{' '}
                  <span className="font-mono text-accent">v1.4</span> for later optimization.
                </div>
              </Card>
            </>
          ) : (
            <Card>
              <div className="p-10 text-center text-slate-500 text-sm">No rejections selected</div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="font-mono text-sm text-slate-100 mt-0.5 truncate">{value}</div>
    </div>
  );
}
