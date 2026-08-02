import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Database,
  Brain,
  Send,
  Shield,
  Cpu,
  Building2,
  ArrowDown,
} from 'lucide-react';
import { PageHeader, Card, Badge, Button } from '../components/ui';
import { useTradingStore } from '../hooks/useTradingStore';
import { formatDateTime } from '../lib/engine';

const stages = [
  {
    id: 'data',
    name: 'Market Data',
    icon: Database,
    desc: 'Normalized ticks, candles, spreads, and data-quality scores. Corrupted feeds halt the pipeline.',
    produces: 'MarketState',
  },
  {
    id: 'strategy',
    name: 'Strategy Engine',
    icon: Brain,
    desc: 'Structure, BOS, volume, regime, session intelligence. Never predicts — reacts to confirmed behavior.',
    produces: 'SetupLifecycle',
  },
  {
    id: 'signal',
    name: 'Trade Signal',
    icon: Send,
    desc: 'Immutable TradeSignal object only. Strategy stops here — it never places trades.',
    produces: 'TradeSignal',
  },
  {
    id: 'risk',
    name: 'Risk Manager',
    icon: Shield,
    desc: 'Position size, portfolio heat, daily loss, correlation. Can reject any signal.',
    produces: 'RiskDecision',
  },
  {
    id: 'execution',
    name: 'Execution Engine',
    icon: Cpu,
    desc: 'Broker safety checks, order construction, routing, fill handling.',
    produces: 'OrderTicket',
  },
  {
    id: 'broker',
    name: 'Broker',
    icon: Building2,
    desc: 'Live destination. Fills stream back into journal, logs, and session metrics.',
    produces: 'Fill / Reject',
  },
];

export default function Pipeline() {
  const { signals, emitDemoSignal, mode, safety } = useTradingStore();
  const latest = signals[0];
  const safetyOk = safety.every((s) => s.passed);

  const signalJson = useMemo(() => {
    if (!latest) return '{}';
    return JSON.stringify(
      {
        id: latest.id,
        timestamp: latest.timestamp,
        instrument: latest.instrument,
        side: latest.side,
        entry: latest.entry,
        stop: latest.stop,
        target: latest.target,
        confidence: Number(latest.confidence.toFixed(2)),
        riskReward: latest.riskReward,
        session: latest.session,
        marketRegime: latest.marketRegime,
        strategyVersion: latest.strategyVersion,
        structure: latest.structure,
        indicators: latest.indicators,
        status: latest.status,
        note: 'Strategy produces only this object. Execution is handled elsewhere.',
      },
      null,
      2
    );
  }, [latest]);

  return (
    <div>
      <PageHeader
        title="Signal & Execution Separation"
        subtitle="Architecture enforces a hard boundary: strategy analyzes and emits signals; risk and execution decide whether capital is deployed."
        actions={
          <Button onClick={emitDemoSignal} variant="primary">
            Emit TradeSignal
          </Button>
        }
      />

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-0">
          {stages.map((stage, i) => {
            const Icon = stage.icon;
            const blocked =
              (mode === 'SAFE_MODE' && i >= 3) || (!safetyOk && stage.id === 'execution');
            return (
              <div key={stage.id}>
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.06 }}
                  className={`rounded-xl border p-4 ${
                    blocked
                      ? 'border-rose-500/30 bg-rose-500/5'
                      : 'border-line bg-panel'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`h-10 w-10 rounded-lg border flex items-center justify-center shrink-0 ${
                        blocked
                          ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                          : 'border-accent/30 bg-accent/10 text-accent'
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-white">{stage.name}</h3>
                        <Badge tone="neutral">{stage.produces}</Badge>
                        {blocked && <Badge tone="bad">Blocked</Badge>}
                      </div>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">{stage.desc}</p>
                    </div>
                  </div>
                </motion.div>
                {i < stages.length - 1 && (
                  <div className="flex justify-center py-1">
                    <ArrowDown className="h-4 w-4 text-slate-600" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="space-y-4">
          <Card title="Latest TradeSignal Object">
            <div className="p-4">
              {latest ? (
                <>
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <Badge
                      tone={
                        latest.status === 'REJECTED'
                          ? 'bad'
                          : latest.status === 'EXECUTED' || latest.status === 'APPROVED'
                            ? 'good'
                            : 'accent'
                      }
                    >
                      {latest.status}
                    </Badge>
                    <span className="text-[11px] text-slate-500 font-mono">
                      {formatDateTime(latest.timestamp)}
                    </span>
                  </div>
                  <pre className="text-[11px] font-mono text-emerald-300/90 bg-surface border border-line rounded-lg p-4 overflow-x-auto leading-relaxed">
                    {signalJson}
                  </pre>
                </>
              ) : (
                <div className="text-sm text-slate-500 p-4">No signals yet</div>
              )}
            </div>
          </Card>

          <Card title="Hard Rules">
            <ul className="p-5 space-y-3 text-sm text-slate-300">
              <Rule text="Strategy Engine has zero broker credentials and cannot call placeOrder." />
              <Rule text="TradeSignal is immutable after emission — risk may only approve or reject." />
              <Rule text="Execution Engine runs Broker Safety before any order ticket." />
              <Rule text="SAFE MODE short-circuits the pipeline after Risk Manager." />
              <Rule text="Every handoff is logged with enough state to reproduce the decision." />
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Rule({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className="text-accent mt-0.5">✓</span>
      <span className="text-slate-400">{text}</span>
    </li>
  );
}
