import { useMemo } from 'react';
import type { Candle } from '../lib/types';

export default function CandleChart({
  candles,
  height = 220,
}: {
  candles: Candle[];
  height?: number;
}) {
  const { path, volMax, min, max, last } = useMemo(() => {
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const minP = Math.min(...lows);
    const maxP = Math.max(...highs);
    const pad = (maxP - minP) * 0.08 || 0.0001;
    return {
      min: minP - pad,
      max: maxP + pad,
      volMax: Math.max(...candles.map((c) => c.volume)),
      last: candles[candles.length - 1],
      path: null as null,
      entryY: 0,
      stopY: 0,
      targetY: 0,
    };
  }, [candles]);

  const width = 800;
  const chartH = height - 36;
  const candleW = width / candles.length;

  const yScale = (p: number) => {
    const t = (p - min) / (max - min || 1);
    return chartH - t * chartH;
  };

  const entry = last?.close ?? 0;
  const stop = entry - (max - min) * 0.18;
  const target = entry + (max - min) * 0.36;

  void path;

  return (
    <div className="w-full overflow-hidden">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" preserveAspectRatio="none">
        <defs>
          <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0.05" />
          </linearGradient>
        </defs>

        {/* grid */}
        {[0.25, 0.5, 0.75].map((g) => (
          <line
            key={g}
            x1={0}
            x2={width}
            y1={chartH * g}
            y2={chartH * g}
            stroke="#1e293b"
            strokeWidth={1}
          />
        ))}

        {/* target / stop / entry */}
        <line
          x1={0}
          x2={width}
          y1={yScale(target)}
          y2={yScale(target)}
          stroke="#34d399"
          strokeWidth={1}
          strokeDasharray="4 4"
          opacity={0.5}
        />
        <line
          x1={0}
          x2={width}
          y1={yScale(entry)}
          y2={yScale(entry)}
          stroke="#2dd4bf"
          strokeWidth={1}
          opacity={0.7}
        />
        <line
          x1={0}
          x2={width}
          y1={yScale(stop)}
          y2={yScale(stop)}
          stroke="#fb7185"
          strokeWidth={1}
          strokeDasharray="4 4"
          opacity={0.5}
        />

        {candles.map((c, i) => {
          const x = i * candleW + candleW * 0.5;
          const bull = c.close >= c.open;
          const color = bull ? '#34d399' : '#fb7185';
          const bodyTop = yScale(Math.max(c.open, c.close));
          const bodyBot = yScale(Math.min(c.open, c.close));
          const bodyH = Math.max(1, bodyBot - bodyTop);
          const volH = (c.volume / volMax) * 28;
          return (
            <g key={c.time}>
              <line
                x1={x}
                x2={x}
                y1={yScale(c.high)}
                y2={yScale(c.low)}
                stroke={color}
                strokeWidth={1}
                opacity={0.85}
              />
              <rect
                x={x - candleW * 0.3}
                y={bodyTop}
                width={Math.max(1, candleW * 0.6)}
                height={bodyH}
                fill={color}
                opacity={0.9}
              />
              <rect
                x={x - candleW * 0.3}
                y={height - volH}
                width={Math.max(1, candleW * 0.6)}
                height={volH}
                fill="url(#volGrad)"
              />
            </g>
          );
        })}

        <text x={width - 8} y={yScale(target) - 4} textAnchor="end" fill="#34d399" fontSize="10">
          TP
        </text>
        <text x={width - 8} y={yScale(entry) - 4} textAnchor="end" fill="#2dd4bf" fontSize="10">
          ENTRY
        </text>
        <text x={width - 8} y={yScale(stop) + 12} textAnchor="end" fill="#fb7185" fontSize="10">
          SL
        </text>
      </svg>
    </div>
  );
}
