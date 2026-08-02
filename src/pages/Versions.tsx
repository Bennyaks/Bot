import { useState } from 'react';
import { motion } from 'framer-motion';
import { GitBranch, ArrowRight, FlaskConical } from 'lucide-react';
import { PageHeader, Card, Badge, ProgressBar, Button } from '../components/ui';
import { strategyVersions } from '../lib/data';
import type { StrategyVersion } from '../lib/types';

export default function Versions() {
  const [selected, setSelected] = useState<string>('v1.4');
  const [compare, setCompare] = useState<string>('v1.3');

  const current = strategyVersions.find((v) => v.version === selected)!;
  const other = strategyVersions.find((v) => v.version === compare)!;

  const lifecycle = ['draft', 'backtesting', 'paper', 'live', 'retired'] as const;

  return (
    <div>
      <PageHeader
        title="Strategy Version Control"
        subtitle="Every strategy change creates a new version. Never overwrite previous versions. Compare performance before promotion."
      />

      {/* Lifecycle flow */}
      <Card className="mb-5">
        <div className="p-5 flex flex-wrap items-center justify-center gap-2 text-sm">
          {['Strategy vN', 'Backtest', 'Paper Trade', 'Improvements', 'Strategy vN+1', 'Compare'].map(
            (step, i, arr) => (
              <div key={step} className="flex items-center gap-2">
                <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-accent text-xs font-medium">
                  {step}
                </div>
                {i < arr.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-slate-600" />}
              </div>
            )
          )}
        </div>
      </Card>

      <div className="grid lg:grid-cols-3 gap-4 mb-5">
        <Card title="Version Tree" className="lg:col-span-1">
          <div className="divide-y divide-line max-h-[520px] overflow-y-auto">
            {strategyVersions.map((v) => (
              <button
                key={v.version}
                type="button"
                onClick={() => setSelected(v.version)}
                className={`w-full text-left px-4 py-3 transition-colors ${
                  selected === v.version
                    ? 'bg-accent/10'
                    : 'hover:bg-white/3'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-3.5 w-3.5 text-slate-500" />
                    <span className="font-mono text-sm text-white">{v.version}</span>
                  </div>
                  <StatusBadge status={v.status} />
                </div>
                <div className="text-[11px] text-slate-500 mt-1">
                  {v.createdAt}
                  {v.parentVersion ? ` · from ${v.parentVersion}` : ' · root'}
                </div>
                <div className="mt-2 flex gap-3 text-[11px] font-mono text-slate-400">
                  <span>WR {v.metrics.winRate}%</span>
                  <span>PF {v.metrics.profitFactor}</span>
                  <span>R {v.metrics.averageR}</span>
                </div>
              </button>
            ))}
          </div>
        </Card>

        <div className="lg:col-span-2 space-y-4">
          <Card>
            <div className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-display text-2xl text-white">{current.version}</h2>
                  <p className="text-xs text-slate-500 mt-1">
                    Created {current.createdAt}
                    {current.parentVersion && ` · parent ${current.parentVersion}`}
                  </p>
                </div>
                <StatusBadge status={current.status} />
              </div>

              <div className="flex flex-wrap gap-2 mb-5">
                {lifecycle.map((s) => {
                  const idx = lifecycle.indexOf(s);
                  const cur = lifecycle.indexOf(current.status);
                  const done = idx <= cur || current.status === 'retired';
                  const active = s === current.status;
                  return (
                    <div
                      key={s}
                      className={`px-2.5 py-1 rounded border text-[10px] uppercase tracking-wider ${
                        active
                          ? 'border-accent/40 bg-accent/15 text-accent'
                          : done
                            ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-500/80'
                            : 'border-line text-slate-600'
                      }`}
                    >
                      {s}
                    </div>
                  );
                })}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
                <Metric label="Win Rate" value={`${current.metrics.winRate}%`} />
                <Metric label="Profit Factor" value={current.metrics.profitFactor.toFixed(2)} />
                <Metric label="Average R" value={current.metrics.averageR.toFixed(2)} />
                <Metric label="Max DD" value={`${current.metrics.maxDrawdown}%`} />
                <Metric label="Trades" value={String(current.metrics.totalTrades)} />
                <Metric label="Sharpe" value={current.metrics.sharpe.toFixed(2)} />
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
                  Changelog
                </div>
                <ul className="space-y-2">
                  {current.changelog.map((c) => (
                    <li
                      key={c}
                      className="flex items-start gap-2 text-sm text-slate-300"
                    >
                      <span className="text-accent mt-1">▸</span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>

          <Card
            title="Compare Performance"
            action={
              <select
                value={compare}
                onChange={(e) => setCompare(e.target.value)}
                className="bg-surface border border-line rounded px-2 py-1 text-xs text-slate-300"
              >
                {strategyVersions
                  .filter((v) => v.version !== selected)
                  .map((v) => (
                    <option key={v.version} value={v.version}>
                      {v.version}
                    </option>
                  ))}
              </select>
            }
          >
            <div className="p-5 space-y-4">
              {(
                [
                  ['Win Rate', current.metrics.winRate, other.metrics.winRate, '%'],
                  ['Profit Factor', current.metrics.profitFactor, other.metrics.profitFactor, ''],
                  ['Average R', current.metrics.averageR, other.metrics.averageR, 'R'],
                  ['Max Drawdown', current.metrics.maxDrawdown, other.metrics.maxDrawdown, '%', true],
                  ['Sharpe', current.metrics.sharpe, other.metrics.sharpe, ''],
                ] as [string, number, number, string, boolean?][]
              ).map(([label, a, b, unit, invert]) => {
                const better = invert ? a < b : a > b;
                const delta = a - b;
                return (
                  <div key={label}>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-slate-400">{label}</span>
                      <span className="font-mono">
                        <span className="text-white">
                          {a}
                          {unit}
                        </span>
                        <span className="text-slate-600 mx-2">vs</span>
                        <span className="text-slate-400">
                          {b}
                          {unit}
                        </span>
                        <span className={`ml-2 ${better ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {delta > 0 ? '+' : ''}
                          {delta.toFixed(2)}
                          {unit}
                        </span>
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <ProgressBar
                        value={invert ? Math.max(0, 20 - a) * 5 : a}
                        max={invert ? 100 : label === 'Win Rate' ? 100 : label.includes('R') && !label.includes('Draw') ? 1 : 3}
                        tone="accent"
                      />
                      <ProgressBar
                        value={invert ? Math.max(0, 20 - b) * 5 : b}
                        max={invert ? 100 : label === 'Win Rate' ? 100 : label.includes('R') && !label.includes('Draw') ? 1 : 3}
                        tone="warn"
                      />
                    </div>
                  </div>
                );
              })}
              <div className="flex gap-2 text-[10px] text-slate-500 pt-1">
                <span className="text-accent">■ {current.version}</span>
                <span className="text-amber-400">■ {other.version}</span>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {current.status === 'backtesting' && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="rounded-xl border border-sky-500/30 bg-sky-500/8 p-4 flex items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3">
            <FlaskConical className="h-5 w-5 text-sky-400" />
            <div>
              <div className="text-sm text-sky-300 font-medium">{current.version} in backtest</div>
              <div className="text-xs text-slate-400">
                Promote to paper only after walk-forward validation clears PF ≥ 1.5 and DD ≤ 5%.
              </div>
            </div>
          </div>
          <Button variant="ghost">View Report</Button>
        </motion.div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: StrategyVersion['status'] }) {
  const tone =
    status === 'live'
      ? 'good'
      : status === 'backtesting' || status === 'paper'
        ? 'info'
        : status === 'draft'
          ? 'warn'
          : 'neutral';
  return <Badge tone={tone}>{status}</Badge>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="font-mono text-lg text-white mt-0.5">{value}</div>
    </div>
  );
}
