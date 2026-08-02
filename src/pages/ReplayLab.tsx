import { useEffect, useState } from 'react';
import { PageHeader, Card, Badge, Button } from '../components/ui';
import CandleChart from '../components/CandleChart';
import { useTradingStore } from '../hooks/useTradingStore';
import { INSTRUMENTS } from '../lib/data';
import type { ReplaySpeed } from '../core/replay/ReplayController';
import { Play, Pause, SkipForward, RotateCcw, Target, XCircle } from 'lucide-react';

const SPEEDS: ReplaySpeed[] = [0.5, 1, 2, 4, 8];

export default function ReplayLab() {
  const {
    replay,
    csvInstruments,
    startReplay,
    replayPlay,
    replayPause,
    replayStep,
    replaySetSpeed,
    replaySeek,
    replayReset,
    replayTryOpenTrade,
    replayCloseTrade,
  } = useTradingStore();

  const [instrument, setInstrument] = useState('EURUSD');

  // Load a fresh replay whenever the selected instrument changes, and once on mount.
  useEffect(() => {
    startReplay(instrument);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument]);

  const progressPct = replay.total > 0 ? (replay.index / replay.total) * 100 : 0;

  return (
    <div>
      <PageHeader
        title="Replay Lab"
        subtitle="Pause, step, and scrub through real or synthetic candles one bar at a time — open a trade at any point and watch PositionManager's real breakeven/trailing/stop/target decisions unfold, through the exact same engine BacktestHarness and the live pipeline use."
      />

      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <Card title={`${replay.instrument} · ${replay.dataSource === 'csv' ? 'Real History' : 'Synthetic'}`}>
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <select
                value={instrument}
                onChange={(e) => setInstrument(e.target.value)}
                className="rounded-md border border-line bg-surface/60 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-accent/50"
              >
                {INSTRUMENTS.map((sym) => (
                  <option key={sym} value={sym}>
                    {sym} {csvInstruments.includes(sym) ? '(real history loaded)' : ''}
                  </option>
                ))}
              </select>

              <div className="flex items-center gap-1.5">
                <Button variant="ghost" onClick={replayReset}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
                {replay.playing ? (
                  <Button variant="primary" onClick={replayPause}>
                    <Pause className="h-3.5 w-3.5" />
                    Pause
                  </Button>
                ) : (
                  <Button variant="primary" onClick={replayPlay} disabled={replay.complete}>
                    <Play className="h-3.5 w-3.5" />
                    Play
                  </Button>
                )}
                <Button variant="ghost" onClick={replayStep} disabled={replay.complete}>
                  <SkipForward className="h-3.5 w-3.5" />
                  Step
                </Button>
                <div className="flex items-center rounded-md border border-line overflow-hidden ml-1">
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      onClick={() => replaySetSpeed(s)}
                      className={`px-2 py-1.5 text-[11px] font-mono transition-colors ${
                        replay.speed === s
                          ? 'bg-accent/20 text-accent'
                          : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <input
                type="range"
                min={0}
                max={Math.max(replay.total - 1, 0)}
                value={replay.index}
                onChange={(e) => replaySeek(Number(e.target.value))}
                className="w-full accent-accent"
              />
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                <span>
                  bar {replay.index} / {replay.total}
                </span>
                <span>{progressPct.toFixed(0)}%</span>
                {replay.complete && <Badge tone="warn">Complete</Badge>}
              </div>
            </div>

            {replay.windowCandles.length > 1 ? (
              <CandleChart candles={replay.windowCandles} height={280} />
            ) : (
              <div className="h-[280px] flex items-center justify-center text-xs text-slate-600 border border-dashed border-line rounded-lg">
                Press Play or Step to start seeing candles
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Open a Trade Here">
            <div className="p-4 space-y-3">
              <p className="text-[11px] text-slate-500">
                Runs BreakoutStrategy over the candles played so far — the exact same strategy, Decision
                Engine, and Risk Manager the live pipeline uses. If it produces an approved setup, it fills
                and starts managing bar-by-bar as you play/step forward.
              </p>
              <Button
                variant="primary"
                className="w-full justify-center"
                onClick={() => void replayTryOpenTrade()}
                disabled={!!replay.openTrade && replay.openTrade.status === 'OPEN'}
              >
                <Target className="h-3.5 w-3.5" />
                Try Setup Here
              </Button>
            </div>
          </Card>

          <Card title="Open Position">
            {replay.openTrade ? (
              <div className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-slate-300">{replay.openTrade.id}</span>
                  <Badge
                    tone={
                      replay.openTrade.status === 'OPEN'
                        ? 'warn'
                        : replay.openTrade.status === 'WIN'
                          ? 'good'
                          : replay.openTrade.status === 'LOSS'
                            ? 'bad'
                            : 'neutral'
                    }
                  >
                    {replay.openTrade.status}
                  </Badge>
                </div>
                {replay.lifecycleState && (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-500">Lifecycle</span>
                    <Badge tone="accent">{replay.lifecycleState}</Badge>
                  </div>
                )}
                <Row label="Side" value={replay.openTrade.side} />
                <Row label="Entry" value={replay.openTrade.entry.toFixed(5)} />
                <Row label="Stop" value={replay.openTrade.stop.toFixed(5)} />
                <Row label="Target" value={replay.openTrade.target.toFixed(5)} />
                <Row label="Lot Size" value={String(replay.openTrade.lotSize)} />
                {replay.openTrade.pnlR != null && <Row label="R multiple" value={`${replay.openTrade.pnlR}R`} />}
                {replay.openTrade.status === 'OPEN' && (
                  <Button variant="danger" className="w-full justify-center mt-2" onClick={replayCloseTrade}>
                    <XCircle className="h-3.5 w-3.5" />
                    Close Now
                  </Button>
                )}
              </div>
            ) : (
              <div className="p-4 text-xs text-slate-600">No position open in this replay.</div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-200">{value}</span>
    </div>
  );
}
