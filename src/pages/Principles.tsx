import { motion } from 'framer-motion';
import { Scale, Shield } from 'lucide-react';
import { PageHeader, Card } from '../components/ui';
import { principles } from '../lib/data';

export default function Principles() {
  return (
    <div>
      <PageHeader
        title="Final Engineering Principles"
        subtitle="The completed system satisfies these non-negotiable principles. Safety overrides profitability. Long-term consistency beats short-term gains."
      />

      <div className="grid md:grid-cols-2 gap-3 mb-6">
        {principles.map((p, i) => (
          <motion.div
            key={p}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className="flex items-start gap-3 rounded-xl border border-line bg-panel px-4 py-3.5"
          >
            <div className="h-6 w-6 rounded-md border border-accent/30 bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-accent text-xs">✓</span>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">{p}</p>
          </motion.div>
        ))}
      </div>

      <Card>
        <div className="p-6 md:p-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg border border-accent/30 bg-accent/10 flex items-center justify-center">
              <Scale className="h-5 w-5 text-accent" />
            </div>
            <div>
              <h2 className="font-display text-xl text-white">Final Goal</h2>
              <p className="text-xs text-slate-500">Not a simple breakout bot</p>
            </div>
          </div>
          <p className="text-slate-300 leading-relaxed max-w-3xl">
            Build a professional, modular, event-driven algorithmic trading platform capable of
            continuously analyzing live markets, detecting only high-quality breakout opportunities,
            rejecting poor-quality trades automatically, protecting trading capital, explaining every
            decision, logging every event, monitoring its own health, and remaining scalable,
            maintainable, and extensible for future strategy enhancements without major architectural
            changes.
          </p>

          <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { t: 'Analyze', d: 'Live markets continuously' },
              { t: 'Detect', d: 'High-quality breakouts only' },
              { t: 'Reject', d: 'Poor setups automatically' },
              { t: 'Protect', d: 'Capital before profit' },
              { t: 'Explain', d: 'Every accept & reject' },
              { t: 'Log', d: 'Fully reproducible events' },
              { t: 'Monitor', d: 'Self-diagnostics always on' },
              { t: 'Extend', d: 'Versioned strategies' },
            ].map((item) => (
              <div
                key={item.t}
                className="rounded-lg border border-line bg-surface/50 px-3 py-3"
              >
                <div className="flex items-center gap-1.5 text-accent text-xs font-semibold uppercase tracking-wider">
                  <Shield className="h-3 w-3" />
                  {item.t}
                </div>
                <div className="text-sm text-slate-400 mt-1">{item.d}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
