import { motion } from 'framer-motion';
import {
  HeartPulse,
  AlertOctagon,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { PageHeader, Card, Badge, Button } from '../components/ui';
import { useTradingStore } from '../hooks/useTradingStore';
import type { HealthStatus } from '../lib/types';

export default function Diagnostics() {
  const { health, mode, modeReason, toggleHealth } = useTradingStore();

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
    </div>
  );
}

function StatusIcon({ status, small }: { status: HealthStatus; small?: boolean }) {
  const cls = small ? 'h-3.5 w-3.5' : 'h-5 w-5';
  if (status === 'healthy') return <CheckCircle2 className={`${cls} text-emerald-400`} />;
  if (status === 'degraded') return <AlertTriangle className={`${cls} text-amber-400`} />;
  return <XCircle className={`${cls} text-rose-400`} />;
}
