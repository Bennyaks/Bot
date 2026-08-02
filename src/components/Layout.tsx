import { NavLink, Outlet } from 'react-router-dom';
import {
  Activity,
  ShieldCheck,
  BookOpen,
  GitBranch,
  Workflow,
  HeartPulse,
  ScrollText,
  LayoutDashboard,
  Scale,
  Radio,
  PlaySquare,
} from 'lucide-react';
import { accountStats } from '../lib/data';
import { money } from '../lib/engine';
import { useTradingStore } from '../hooks/useTradingStore';

const nav = [
  { to: '/', label: 'Command', icon: LayoutDashboard },
  { to: '/sessions', label: 'Sessions', icon: Activity },
  { to: '/safety', label: 'Broker Safety', icon: ShieldCheck },
  { to: '/journal', label: 'Journal', icon: BookOpen },
  { to: '/versions', label: 'Versions', icon: GitBranch },
  { to: '/pipeline', label: 'Pipeline', icon: Workflow },
  { to: '/diagnostics', label: 'Diagnostics', icon: HeartPulse },
  { to: '/replay', label: 'Replay Lab', icon: PlaySquare },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/principles', label: 'Principles', icon: Scale },
];

export default function Layout() {
  const { mode, clock } = useTradingStore();

  return (
    <div className="min-h-screen bg-surface text-slate-100 flex">
      <aside className="w-60 shrink-0 border-r border-line bg-panel flex flex-col">
        <div className="px-5 py-5 border-b border-line">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-accent/15 border border-accent/40 flex items-center justify-center">
              <Radio className="h-4.5 w-4.5 text-accent" />
            </div>
            <div>
              <div className="font-display text-sm font-semibold tracking-wide text-white">
                APEX ENGINE
              </div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                Algo Platform
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors ${
                  isActive
                    ? 'bg-accent/12 text-accent border border-accent/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/3 border border-transparent'
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-line space-y-2">
          <div className="rounded-md bg-surface border border-line p-3">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Equity</div>
            <div className="font-mono text-sm text-white">{money(accountStats.equity)}</div>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className="text-slate-500">Day R</span>
              <span className={accountStats.dayPnlR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {accountStats.dayPnlR >= 0 ? '+' : ''}
                {accountStats.dayPnlR.toFixed(2)}R
              </span>
            </div>
          </div>
          <div className="text-[10px] text-slate-600 text-center font-mono">{clock}</div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-line bg-panel/80 backdrop-blur flex items-center justify-between px-6 shrink-0">
          <div className="flex items-center gap-4">
            <StatusPill
              label={mode}
              tone={mode === 'SAFE_MODE' ? 'danger' : mode === 'LIVE' ? 'ok' : 'warn'}
            />
            <StatusPill label={`Strategy ${accountStats.strategyVersion}`} tone="neutral" />
            <StatusPill label={`${accountStats.openPositions} Open`} tone="neutral" />
          </div>
          <div className="flex items-center gap-6 text-xs">
            <Metric label="WR" value={`${accountStats.winRate}%`} />
            <Metric label="PF" value={accountStats.profitFactor.toFixed(2)} />
            <Metric label="Avg R" value={accountStats.avgR.toFixed(2)} />
            <Metric
              label="Open PnL"
              value={money(accountStats.openPnl)}
              positive={accountStats.openPnl >= 0}
            />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
}) {
  const tones = {
    ok: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    danger: 'bg-rose-500/10 text-rose-400 border-rose-500/30 animate-pulse',
    neutral: 'bg-white/5 text-slate-300 border-line',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-medium tracking-wide ${tones[tone]}`}
    >
      {tone === 'ok' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
      {tone === 'danger' && <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />}
      {label}
    </span>
  );
}

function Metric({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div
        className={`font-mono text-sm ${
          positive === undefined ? 'text-slate-200' : positive ? 'text-emerald-400' : 'text-rose-400'
        }`}
      >
        {value}
      </div>
    </div>
  );
}
