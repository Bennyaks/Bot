import { useMemo, useState } from 'react';
import { PageHeader, Card, Badge, Button } from '../components/ui';
import { useTradingStore } from '../hooks/useTradingStore';
import type { LogEntry } from '../lib/types';

const levels: Array<LogEntry['level'] | 'ALL'> = [
  'ALL',
  'DEBUG',
  'INFO',
  'WARN',
  'ERROR',
  'TRADE',
  'REJECT',
  'SAFETY',
];

export default function Logs() {
  const { logs } = useTradingStore();
  const [level, setLevel] = useState<(typeof levels)[number]>('ALL');
  const [moduleFilter, setModuleFilter] = useState('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const modules = useMemo(() => {
    const set = new Set(logs.map((l) => l.module));
    return ['ALL', ...Array.from(set).sort()];
  }, [logs]);

  const filtered = logs.filter((l) => {
    if (level !== 'ALL' && l.level !== level) return false;
    if (moduleFilter !== 'ALL' && l.module !== moduleFilter) return false;
    return true;
  });

  const selected = logs.find((l) => l.id === selectedId) ?? filtered[0];

  return (
    <div>
      <PageHeader
        title="Enhanced Logging System"
        subtitle="Simulated dashboard activity (demo data) — for your real MT5 connection's logs, go to Live Trading instead."
      />

      <div className="flex flex-wrap gap-2 mb-4">
        {levels.map((l) => (
          <Button
            key={l}
            variant={level === l ? 'primary' : 'ghost'}
            onClick={() => setLevel(l)}
          >
            {l}
          </Button>
        ))}
        <select
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
          className="ml-auto bg-panel border border-line rounded-md px-3 py-1.5 text-xs text-slate-300"
        >
          {modules.map((m) => (
            <option key={m} value={m}>
              {m === 'ALL' ? 'All modules' : m}
            </option>
          ))}
        </select>
      </div>

      <div className="grid lg:grid-cols-5 gap-4">
        <Card className="lg:col-span-3" title={`Event Stream (${filtered.length})`}>
          <div className="max-h-[600px] overflow-y-auto font-mono text-[11px]">
            <div className="sticky top-0 grid grid-cols-[70px_70px_120px_1fr] gap-2 px-4 py-2 bg-panel border-b border-line text-slate-600 uppercase tracking-wider text-[9px]">
              <span>Time</span>
              <span>Level</span>
              <span>Module</span>
              <span>Message</span>
            </div>
            {filtered.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setSelectedId(l.id)}
                className={`w-full grid grid-cols-[70px_70px_120px_1fr] gap-2 px-4 py-2 text-left border-b border-line/60 hover:bg-white/3 ${
                  selected?.id === l.id ? 'bg-accent/8' : ''
                }`}
              >
                <span className="text-slate-600">
                  {new Date(l.timestamp).toISOString().slice(11, 19)}
                </span>
                <span className={levelColor(l.level)}>{l.level}</span>
                <span className="text-slate-500 truncate">{l.module}</span>
                <span className="text-slate-300 truncate">{l.message}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card className="lg:col-span-2" title="Reproducible Snapshot">
          {selected ? (
            <div className="p-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge tone={badgeTone(selected.level)}>{selected.level}</Badge>
                <Badge tone="neutral">{selected.module}</Badge>
                {selected.reproducible && <Badge tone="good">Reproducible</Badge>}
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  Timestamp
                </div>
                <div className="font-mono text-sm text-slate-200">{selected.timestamp}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  Message
                </div>
                <div className="text-sm text-slate-300 leading-relaxed">{selected.message}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  Structured Data
                </div>
                <pre className="text-[11px] font-mono text-sky-300/90 bg-surface border border-line rounded-lg p-3 overflow-x-auto">
                  {JSON.stringify(selected.data ?? { note: 'No payload' }, null, 2)}
                </pre>
              </div>
              <div className="rounded-lg border border-line bg-surface/40 p-3 text-[11px] text-slate-500 leading-relaxed">
                Logs capture market state, strategy state, setup lifecycle stage, triggered events,
                indicator values, market structure, risk calculations, execution details, exit
                details, and final performance — enough to rebuild the decision offline.
              </div>
            </div>
          ) : (
            <div className="p-8 text-center text-slate-500 text-sm">Select a log entry</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function levelColor(level: LogEntry['level']) {
  switch (level) {
    case 'ERROR':
    case 'REJECT':
      return 'text-rose-400';
    case 'WARN':
      return 'text-amber-400';
    case 'TRADE':
    case 'SAFETY':
      return 'text-accent';
    case 'DEBUG':
      return 'text-slate-600';
    default:
      return 'text-slate-400';
  }
}

function badgeTone(level: LogEntry['level']): 'bad' | 'warn' | 'good' | 'accent' | 'neutral' {
  if (level === 'ERROR' || level === 'REJECT') return 'bad';
  if (level === 'WARN') return 'warn';
  if (level === 'TRADE' || level === 'SAFETY') return 'accent';
  if (level === 'INFO') return 'good';
  return 'neutral';
}
