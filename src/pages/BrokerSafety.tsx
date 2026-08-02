import { motion } from 'framer-motion';
import { ShieldCheck, ShieldX, RefreshCw, AlertTriangle } from 'lucide-react';
import { PageHeader, Card, Badge, Button } from '../components/ui';
import { useTradingStore } from '../hooks/useTradingStore';

export default function BrokerSafety() {
  const { safety, toggleSafetyCheck, runSafetyAudit, mode } = useTradingStore();
  const passed = safety.filter((s) => s.passed).length;
  const allPass = passed === safety.length;

  return (
    <div>
      <PageHeader
        title="Broker Safety Engine"
        subtitle="Before any order is sent, eight independent checks must pass. Any failure rejects the trade — no exceptions."
        actions={
          <Button onClick={() => runSafetyAudit()} variant="primary">
            <RefreshCw className="h-3.5 w-3.5" />
            Run Audit
          </Button>
        }
      />

      <div
        className={`mb-5 rounded-xl border px-5 py-4 flex items-center justify-between gap-4 ${
          allPass
            ? 'border-emerald-500/30 bg-emerald-500/8'
            : 'border-rose-500/40 bg-rose-500/10'
        }`}
      >
        <div className="flex items-center gap-3">
          {allPass ? (
            <ShieldCheck className="h-8 w-8 text-emerald-400" />
          ) : (
            <ShieldX className="h-8 w-8 text-rose-400" />
          )}
          <div>
            <div className={`text-lg font-display font-semibold ${allPass ? 'text-emerald-300' : 'text-rose-300'}`}>
              {allPass ? 'CLEARED FOR EXECUTION' : 'TRADE REJECTED'}
            </div>
            <div className="text-xs text-slate-400 mt-0.5">
              {passed}/{safety.length} checks passed
              {!allPass && ' · order path blocked at safety gate'}
              {mode === 'SAFE_MODE' && ' · system also in SAFE MODE'}
            </div>
          </div>
        </div>
        <Badge tone={allPass ? 'good' : 'bad'}>{allPass ? 'PASS' : 'FAIL'}</Badge>
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
        {safety.map((check, i) => (
          <motion.button
            key={check.id}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            onClick={() => toggleSafetyCheck(check.id)}
            className={`text-left rounded-xl border p-4 transition-all hover:scale-[1.01] ${
              check.passed
                ? 'border-emerald-500/25 bg-panel hover:border-emerald-500/40'
                : 'border-rose-500/40 bg-rose-500/5 hover:border-rose-500/60'
            }`}
          >
            <div className="flex items-start justify-between gap-2 mb-3">
              <div
                className={`h-9 w-9 rounded-lg border flex items-center justify-center ${
                  check.passed
                    ? 'border-emerald-500/30 bg-emerald-500/10'
                    : 'border-rose-500/30 bg-rose-500/10'
                }`}
              >
                {check.passed ? (
                  <ShieldCheck className="h-4 w-4 text-emerald-400" />
                ) : (
                  <ShieldX className="h-4 w-4 text-rose-400" />
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge tone={check.passed ? 'good' : 'bad'}>
                  {check.passed ? 'Pass' : 'Fail'}
                </Badge>
                {check.critical && <Badge tone="warn">Critical</Badge>}
              </div>
            </div>
            <div className="text-sm font-medium text-white">{check.label}</div>
            <div className="text-[11px] text-slate-500 mt-1">{check.description}</div>
            <div
              className={`mt-3 text-[11px] font-mono ${check.passed ? 'text-slate-400' : 'text-rose-300'}`}
            >
              {check.detail}
            </div>
            <div className="mt-3 text-[10px] text-slate-600">Click to toggle (demo)</div>
          </motion.button>
        ))}
      </div>

      <Card title="Rejection Path">
        <div className="p-5">
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2 md:gap-0">
            {['Signal Ready', 'Risk Manager', 'Broker Safety', 'Execution', 'Broker'].map(
              (step, i) => {
                const blocked = !allPass && step === 'Broker Safety';
                const afterBlock = !allPass && i > 2;
                return (
                  <div key={step} className="flex items-center flex-1">
                    <div
                      className={`flex-1 rounded-lg border px-3 py-3 text-center ${
                        blocked
                          ? 'border-rose-500/40 bg-rose-500/10'
                          : afterBlock
                            ? 'border-line bg-white/2 opacity-40'
                            : 'border-emerald-500/25 bg-emerald-500/5'
                      }`}
                    >
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">
                        Step {i + 1}
                      </div>
                      <div className="text-sm text-slate-200 mt-0.5">{step}</div>
                      {blocked && (
                        <div className="flex items-center justify-center gap-1 mt-1 text-[10px] text-rose-400">
                          <AlertTriangle className="h-3 w-3" />
                          Reject Trade
                        </div>
                      )}
                    </div>
                    {i < 4 && (
                      <div className="hidden md:block w-6 text-center text-slate-600">→</div>
                    )}
                  </div>
                );
              }
            )}
          </div>
          <p className="mt-4 text-xs text-slate-500 leading-relaxed">
            Safety overrides profitability. A high-confidence setup with failing margin, lot size,
            stop distance, or market-open checks is discarded and journaled — never force-sent.
          </p>
        </div>
      </Card>
    </div>
  );
}
