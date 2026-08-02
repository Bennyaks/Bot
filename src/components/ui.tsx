import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-white tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400 max-w-2xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Card({
  children,
  className = '',
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <div className={`rounded-xl border border-line bg-panel ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          {title && (
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
              {title}
            </h3>
          )}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'good' | 'bad' | 'accent';
}) {
  const tones = {
    default: 'text-white',
    good: 'text-emerald-400',
    bad: 'text-rose-400',
    accent: 'text-accent',
  };
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className={`mt-1 font-mono text-xl font-medium ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'accent' | 'info';
}) {
  const tones = {
    neutral: 'bg-white/5 text-slate-300 border-line',
    good: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
    bad: 'bg-rose-500/10 text-rose-400 border-rose-500/25',
    warn: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
    accent: 'bg-accent/10 text-accent border-accent/25',
    info: 'bg-sky-500/10 text-sky-400 border-sky-500/25',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'warn';
  disabled?: boolean;
  className?: string;
}) {
  const variants = {
    primary: 'bg-accent/15 text-accent border-accent/30 hover:bg-accent/25',
    ghost: 'bg-white/5 text-slate-300 border-line hover:bg-white/10',
    danger: 'bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-rose-500/20',
    warn: 'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20',
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function ProgressBar({
  value,
  max = 100,
  tone = 'accent',
}: {
  value: number;
  max?: number;
  tone?: 'accent' | 'good' | 'bad' | 'warn';
}) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const tones = {
    accent: 'bg-accent',
    good: 'bg-emerald-400',
    bad: 'bg-rose-400',
    warn: 'bg-amber-400',
  };
  return (
    <div className="h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
      <motion.div
        className={`h-full rounded-full ${tones[tone]}`}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      />
    </div>
  );
}

export function EmptyRow({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center text-sm text-slate-500">{text}</div>;
}
