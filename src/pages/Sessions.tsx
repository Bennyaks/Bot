import { motion } from 'framer-motion';
import { Globe2, TrendingUp, BarChart3, Clock } from 'lucide-react';
import { PageHeader, Card, Badge, ProgressBar, Stat } from '../components/ui';
import { useTradingStore } from '../hooks/useTradingStore';
import { sessionScore } from '../lib/engine';
import type { SessionName } from '../lib/types';

const sessionMeta: Record<
  SessionName,
  { hours: string; color: string; blurb: string; cities: string }
> = {
  Asian: {
    hours: '00:00 – 08:00 UTC',
    color: 'from-violet-500/20 to-violet-500/5',
    blurb: 'Lower liquidity. Evidence-weighted; often filtered unless PF clears threshold.',
    cities: 'Tokyo · Sydney · Hong Kong',
  },
  London: {
    hours: '07:00 – 16:00 UTC',
    color: 'from-accent/25 to-accent/5',
    blurb: 'Highest quality breakouts historically. Primary session for live deployment.',
    cities: 'London · Frankfurt · Zurich',
  },
  NewYork: {
    hours: '12:00 – 21:00 UTC',
    color: 'from-sky-500/20 to-sky-500/5',
    blurb: 'Strong continuation after London overlap. News-aware filters mandatory.',
    cities: 'New York · Chicago · Toronto',
  },
};

export default function Sessions() {
  const { sessionMetrics } = useTradingStore();

  const ranked = [...sessionMetrics].sort((a, b) => b.profitFactor - a.profitFactor);

  return (
    <div>
      <PageHeader
        title="Session Intelligence Engine"
        subtitle="Measure sessions — don't only filter them. Win rate, profit factor, average R, and trade frequency drive future optimization."
      />

      <div className="grid sm:grid-cols-3 gap-3 mb-5">
        <Stat
          label="Best Session"
          value={ranked[0].session}
          sub={`PF ${ranked[0].profitFactor.toFixed(2)}`}
          tone="good"
        />
        <Stat
          label="Active Now"
          value={sessionMetrics.find((s) => s.active)?.session ?? '—'}
          sub="UTC clock based"
          tone="accent"
        />
        <Stat
          label="Evidence Trades"
          value={String(sessionMetrics.reduce((a, s) => a + s.totalTrades, 0))}
          sub="across all sessions"
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-5">
        {sessionMetrics.map((s, i) => {
          const meta = sessionMeta[s.session];
          const score = sessionScore(s.session, s);
          return (
            <motion.div
              key={s.session}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
            >
              <Card className="overflow-hidden h-full">
                <div className={`bg-gradient-to-br ${meta.color} px-5 pt-5 pb-4 border-b border-line`}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Globe2 className="h-5 w-5 text-slate-300" />
                      <div>
                        <h3 className="font-display text-lg text-white">{s.session}</h3>
                        <p className="text-[11px] text-slate-400">{meta.cities}</p>
                      </div>
                    </div>
                    {s.active ? (
                      <Badge tone="good">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Idle</Badge>
                    )}
                  </div>
                  <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
                    <Clock className="h-3 w-3" />
                    {meta.hours}
                  </div>
                </div>

                <div className="p-5 space-y-4">
                  <MetricRow
                    icon={<TrendingUp className="h-3.5 w-3.5" />}
                    label="Win Rate"
                    value={`${s.winRate.toFixed(1)}%`}
                    bar={s.winRate}
                    tone={s.winRate >= 55 ? 'good' : s.winRate >= 50 ? 'warn' : 'bad'}
                  />
                  <MetricRow
                    icon={<BarChart3 className="h-3.5 w-3.5" />}
                    label="Profit Factor"
                    value={s.profitFactor.toFixed(2)}
                    bar={Math.min(100, (s.profitFactor / 2.5) * 100)}
                    tone={s.profitFactor >= 1.5 ? 'good' : s.profitFactor >= 1.2 ? 'warn' : 'bad'}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Mini label="Average R" value={`${s.averageR >= 0 ? '+' : ''}${s.averageR.toFixed(2)}R`} />
                    <Mini label="Trades / Day" value={s.tradeFrequency.toFixed(1)} />
                    <Mini label="Total Trades" value={String(s.totalTrades)} />
                    <Mini
                      label="Net R"
                      value={`${s.netR >= 0 ? '+' : ''}${s.netR.toFixed(1)}R`}
                      good={s.netR >= 0}
                    />
                  </div>

                  <div className="rounded-lg border border-line bg-surface/50 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                      Evidence Gate
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-300">{score.reason}</span>
                      <Badge tone={score.allow ? 'good' : 'bad'}>
                        {score.allow ? 'Allow' : 'Block'}
                      </Badge>
                    </div>
                    <div className="mt-2">
                      <ProgressBar value={score.score * 100} tone={score.allow ? 'good' : 'bad'} />
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-500 leading-relaxed">{meta.blurb}</p>

                  <div className="flex justify-between text-[11px] text-slate-500 pt-1 border-t border-line">
                    <span>Best {s.bestHour}</span>
                    <span>Worst {s.worstHour}</span>
                  </div>
                </div>
              </Card>
            </motion.div>
          );
        })}
      </div>

      <Card title="Optimization Insights">
        <div className="p-5 grid md:grid-cols-3 gap-4 text-sm">
          <Insight
            title="Prefer London open"
            body="PF 1.87 and +0.72R average make London the primary allocation window. Size up only here."
          />
          <Insight
            title="NY after 14:30 UTC"
            body="Best NY hour aligns with US cash open. Avoid late-session low-liquidity fades."
          />
          <Insight
            title="Asian: evidence filter"
            body="WR 48% / PF 1.12 fails the evidence gate. Block discretionary Asian breakouts until PF ≥ 1.15."
          />
        </div>
      </Card>
    </div>
  );
}

function MetricRow({
  icon,
  label,
  value,
  bar,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  bar: number;
  tone: 'good' | 'bad' | 'warn' | 'accent';
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
          {icon}
          {label}
        </span>
        <span className="font-mono text-sm text-white">{value}</span>
      </div>
      <ProgressBar value={bar} tone={tone} />
    </div>
  );
}

function Mini({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div className="rounded-md border border-line bg-surface/40 px-3 py-2">
      <div className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</div>
      <div
        className={`font-mono text-sm mt-0.5 ${
          good === undefined ? 'text-slate-200' : good ? 'text-emerald-400' : 'text-rose-400'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Insight({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface/40 p-4">
      <div className="text-accent text-xs font-semibold uppercase tracking-wider mb-2">{title}</div>
      <p className="text-slate-400 text-xs leading-relaxed">{body}</p>
    </div>
  );
}
