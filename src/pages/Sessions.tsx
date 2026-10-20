import { useEffect, useState } from 'react';
import { PageHeader, Card, Badge } from '../components/ui';

interface SessionDef {
  name: 'Asian' | 'London' | 'New York';
  startUtc: number;
  endUtc: number;
  cities: string;
  blurb: string;
}

const SESSIONS: SessionDef[] = [
  { name: 'Asian', startUtc: 0, endUtc: 8, cities: 'Tokyo, Sydney, Hong Kong', blurb: 'Typically the quietest session — smaller price moves, tighter ranges.' },
  { name: 'London', startUtc: 7, endUtc: 16, cities: 'London, Frankfurt, Zurich', blurb: 'The busiest FX session — most volume and the clearest trends usually happen here.' },
  { name: 'New York', startUtc: 12, endUtc: 21, cities: 'New York, Chicago, Toronto', blurb: 'Overlaps with London for its first few hours — often the most active window of the day.' },
];

function utcHourToLocal(hourUtc: number): string {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function isActive(session: SessionDef, utcHour: number): boolean {
  if (session.startUtc < session.endUtc) {
    return utcHour >= session.startUtc && utcHour < session.endUtc;
  }
  // wraps past midnight UTC
  return utcHour >= session.startUtc || utcHour < session.endUtc;
}

function hoursUntil(session: SessionDef, now: Date): number {
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  let start = session.startUtc;
  if (start <= utcHour) start += 24;
  return start - utcHour;
}

export default function Sessions() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const utcHour = now.getUTCHours();
  const active = SESSIONS.filter((s) => isActive(s, utcHour));
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div>
      <PageHeader
        title="Sessions"
        subtitle="Forex trades around the clock across three overlapping regional sessions. This page shows which one is active right now — it's what the bot uses to reason about timing, not a performance forecast."
      />

      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        <Card className="p-4">
          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Current time (UTC)</div>
          <div className="mt-1 font-mono text-2xl text-white">
            {now.toISOString().slice(11, 19)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Your local time ({localTz}): {now.toLocaleTimeString()}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Active right now</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {active.length === 0 ? (
              <span className="text-slate-500 text-sm">No major session active — quietest time of day.</span>
            ) : (
              active.map((s) => (
                <Badge key={s.name} tone="good">
                  {s.name}
                </Badge>
              ))
            )}
          </div>
          {active.length > 1 && (
            <div className="mt-2 text-[11px] text-emerald-400">
              Session overlap — typically the most active trading window.
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {SESSIONS.map((s) => {
          const live = isActive(s, utcHour);
          const untilStart = hoursUntil(s, now);
          return (
            <Card key={s.name} className="p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-white">{s.name}</div>
                <Badge tone={live ? 'good' : 'neutral'}>{live ? 'Active' : 'Closed'}</Badge>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">{s.cities}</div>
              <div className="mt-3 text-xs text-slate-400">
                {s.startUtc.toString().padStart(2, '0')}:00 – {s.endUtc.toString().padStart(2, '0')}:00 UTC
              </div>
              <div className="text-[11px] text-slate-600">
                ({utcHourToLocal(s.startUtc)} – {utcHourToLocal(s.endUtc)} your time)
              </div>
              {!live && (
                <div className="mt-2 text-[11px] text-slate-500">
                  Opens in {untilStart < 1 ? `${Math.round(untilStart * 60)}m` : `${untilStart.toFixed(1)}h`}
                </div>
              )}
              <p className="mt-3 text-xs text-slate-400 leading-relaxed">{s.blurb}</p>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
