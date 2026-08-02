import { spreadInPrice } from '../../lib/instruments';
import type { Candle } from '../../lib/types';
import type { MarketProvider } from '../../core/interfaces';

export interface CsvParseResult {
  candles: Candle[];
  /** Rows that couldn't be parsed (bad timestamp, non-numeric OHLC, wrong column count) — reported, not silently dropped. */
  skippedRows: number;
  /** Human-readable notes about format decisions made (which column mapping was used, unit inferred for timestamps, etc). */
  notes: string[];
}

const HEADER_ALIASES: Record<string, string[]> = {
  time: ['time', 'date', 'datetime', 'timestamp'],
  open: ['open', 'o'],
  high: ['high', 'h'],
  low: ['low', 'l'],
  close: ['close', 'c', 'adj close', 'adj_close'],
  volume: ['volume', 'vol', 'v'],
};

function normalizeHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/["']/g, '');
}

/** Map a header row to column indices for time/open/high/low/close/volume, or null if it doesn't look like a header at all (first cell isn't a recognized name and isn't clearly text). */
function detectHeader(firstRow: string[]): Record<string, number> | null {
  const normalized = firstRow.map(normalizeHeader);
  const mapping: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = normalized.findIndex((cell) => aliases.includes(cell));
    if (idx !== -1) mapping[field] = idx;
  }
  // Require at minimum time+open+high+low+close resolved by name to trust this as a header row.
  const required = ['time', 'open', 'high', 'low', 'close'];
  if (required.every((f) => f in mapping)) return mapping;
  return null;
}

/** Parse a timestamp cell into epoch milliseconds. Accepts ISO strings, "YYYY-MM-DD[ HH:MM:SS]", unix seconds, or unix milliseconds. */
function parseTimestamp(raw: string): number | null {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (trimmed === '') return null;

  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    // Unix seconds are ~10 digits today; unix ms are ~13. Anything smaller
    // than the year-2001-in-seconds threshold is treated as seconds and
    // scaled up, so both common exports parse without a manual toggle.
    return trimmed.replace('-', '').length <= 10 ? n * 1000 : n;
  }

  const parsed = Date.parse(trimmed.includes(' ') && !trimmed.includes('T') ? trimmed.replace(' ', 'T') : trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function splitCsvLine(line: string): string[] {
  // Minimal CSV split: handles quoted fields containing commas, not fully
  // RFC-4180 (no escaped quotes) — sufficient for the numeric OHLCV exports
  // this is meant to read (MT5/TradingView/most broker exports).
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * lib/csv (parsing lives alongside the provider that's its only consumer)
 * ---------------------------------------------------------------------------
 * Parses OHLC(V) CSV text into Candle[]. Supports two shapes:
 *  - a header row naming the columns (any of the common export conventions
 *    — MT5, TradingView, most broker/data-vendor downloads), in any order
 *  - no recognizable header, in which case columns are assumed to be
 *    time,open,high,low,close[,volume] in that positional order
 *
 * Malformed rows are skipped and counted rather than aborting the whole
 * parse — a single bad row (a footer line, a blank trailing line, a
 * currency symbol that snuck into a cell) shouldn't discard an entire
 * history file.
 */
export function parseCsvCandles(csvText: string): CsvParseResult {
  const notes: string[] = [];
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { candles: [], skippedRows: 0, notes: ['Empty input.'] };
  }

  const firstRowCells = splitCsvLine(lines[0]);
  const headerMapping = detectHeader(firstRowCells);
  const dataLines = headerMapping ? lines.slice(1) : lines;
  const mapping =
    headerMapping ??
    (() => {
      notes.push('No recognizable header row found — assuming column order time,open,high,low,close[,volume].');
      return { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
    })();
  if (headerMapping) {
    notes.push(
      `Header detected — mapped columns: ${Object.entries(headerMapping)
        .map(([f, i]) => `${f}=col${i + 1}`)
        .join(', ')}.`
    );
  }

  const candles: Candle[] = [];
  let skippedRows = 0;

  for (const line of dataLines) {
    const cells = splitCsvLine(line);
    const timeRaw = cells[mapping.time];
    const time = timeRaw != null ? parseTimestamp(timeRaw) : null;
    const open = Number(cells[mapping.open]);
    const high = Number(cells[mapping.high]);
    const low = Number(cells[mapping.low]);
    const close = Number(cells[mapping.close]);
    const volume = mapping.volume != null && cells[mapping.volume] != null ? Number(cells[mapping.volume]) : 0;

    if (
      time == null ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      skippedRows += 1;
      continue;
    }
    candles.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }

  candles.sort((a, b) => a.time - b.time);

  // De-dupe exact-timestamp repeats (some exports include a duplicated
  // final row) — keep the first occurrence, count the rest as skipped.
  const deduped: Candle[] = [];
  let lastTime: number | null = null;
  for (const candle of candles) {
    if (candle.time === lastTime) {
      skippedRows += 1;
      continue;
    }
    deduped.push(candle);
    lastTime = candle.time;
  }

  if (skippedRows > 0) {
    notes.push(`Skipped ${skippedRows} row(s) that were malformed or duplicate timestamps.`);
  }

  return { candles: deduped, skippedRows, notes };
}

/**
 * providers/csv/CsvMarketProvider
 * ----------------------------------
 * Real historical OHLC data instead of ReplayMarketProvider's synthetic
 * generator. Implements the exact same MarketProvider interface, so
 * BacktestHarness, MarketStructureEngine, BreakoutStrategy, and the
 * SystemOrchestrator's spread pricing don't need to know or care which one
 * is wired in — this is the CSV half of "ReplayMarketProvider shouldn't
 * generate data forever": once a strategy needs to be tested against real
 * ranging periods, spikes, and liquidity sweeps instead of a synthetic
 * random-walk, load real history through this and hand it to
 * BacktestHarness exactly like the synthetic candles were.
 *
 * One series per instrument — loadCsv() replaces whatever was previously
 * loaded for that symbol. Symbols with nothing loaded fall back to an
 * empty series (getCandles returns []) rather than throwing, so a
 * multi-instrument scan that only has data for one symbol degrades
 * gracefully on the rest instead of crashing the whole scan.
 */
export class CsvMarketProvider implements MarketProvider {
  id = 'csv-replay';
  private seriesByInstrument = new Map<string, Candle[]>();

  /** Parse and store a CSV history for one instrument. Returns the same diagnostics parseCsvCandles produced, so a caller (a UI upload handler) can surface them. */
  loadCsv(instrument: string, csvText: string): CsvParseResult {
    const result = parseCsvCandles(csvText);
    this.seriesByInstrument.set(instrument, result.candles);
    return result;
  }

  hasData(instrument: string): boolean {
    return (this.seriesByInstrument.get(instrument)?.length ?? 0) > 0;
  }

  loadedInstruments(): string[] {
    return [...this.seriesByInstrument.keys()].filter((sym) => this.hasData(sym));
  }

  clear(instrument: string): void {
    this.seriesByInstrument.delete(instrument);
  }

  /** Full loaded series for an instrument, in chronological order — the shape BacktestHarness.run() wants directly, without the getCandles() windowing below. */
  getFullSeries(instrument: string): Candle[] {
    return this.seriesByInstrument.get(instrument) ?? [];
  }

  getCandles(instrument: string, timeframe: string, count: number): Candle[] {
    void timeframe;
    const series = this.seriesByInstrument.get(instrument) ?? [];
    return series.slice(-count);
  }

  getSpread(instrument: string): number {
    // CSV history is price-only — no recorded bid/ask spread — so fall back
    // to the same typical-spread model ReplayMarketProvider and the
    // instrument specs use everywhere else.
    return spreadInPrice(instrument);
  }

  /** Replays the loaded series forward at a fixed cadence, one candle per tick — same subscribe() shape as ReplayMarketProvider, so a caller can swap providers without changing how it consumes the stream. */
  subscribe(instrument: string, onCandle: (candle: Candle) => void, intervalMs = 1000): () => void {
    const series = this.seriesByInstrument.get(instrument) ?? [];
    let index = 0;
    const interval = setInterval(() => {
      if (index >= series.length) return;
      onCandle(series[index]);
      index += 1;
    }, intervalMs);
    return () => clearInterval(interval);
  }
}
