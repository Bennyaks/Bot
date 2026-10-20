import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Activity, ScrollText, Radio } from 'lucide-react';

const nav = [
  { to: '/', label: 'Live Trading', icon: Radio },
  { to: '/sessions', label: 'Sessions', icon: Activity },
  { to: '/history', label: 'History', icon: ScrollText },
];

export default function Layout() {
  const [clock, setClock] = useState(() => new Date().toISOString().slice(11, 19) + ' UTC');

  useEffect(() => {
    const interval = setInterval(() => {
      setClock(new Date().toISOString().slice(11, 19) + ' UTC');
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-surface text-slate-100 flex">
      <aside className="w-56 shrink-0 border-r border-line bg-panel flex flex-col">
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

        <div className="p-3 border-t border-line">
          <div className="text-[10px] text-slate-600 text-center font-mono">{clock}</div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
