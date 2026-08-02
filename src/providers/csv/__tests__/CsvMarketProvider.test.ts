import { describe, it, expect } from 'vitest';
import { parseCsvCandles, CsvMarketProvider } from '../CsvMarketProvider';

describe('parseCsvCandles', () => {
  it('parses a standard header row (time,open,high,low,close,volume) with ISO timestamps', () => {
    const csv = [
      'time,open,high,low,close,volume',
      '2024-01-01T00:00:00Z,1.1000,1.1010,1.0990,1.1005,1200',
      '2024-01-01T00:15:00Z,1.1005,1.1020,1.1000,1.1015,1500',
    ].join('\n');
    const result = parseCsvCandles(csv);
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]).toMatchObject({ open: 1.1, high: 1.101, low: 1.099, close: 1.1005, volume: 1200 });
    expect(result.candles[1].time).toBeGreaterThan(result.candles[0].time);
    expect(result.skippedRows).toBe(0);
  });

  it('recognizes common header aliases in any column order (Date, Open, High, Low, Close)', () => {
    const csv = ['Date,Close,Open,High,Low', '2024-01-01,1.1005,1.1000,1.1010,1.0990'].join('\n');
    const result = parseCsvCandles(csv);
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]).toMatchObject({ open: 1.1, high: 1.101, low: 1.099, close: 1.1005 });
  });

  it('falls back to positional time,open,high,low,close when no header is recognized', () => {
    const csv = ['2024-01-01T00:00:00Z,1.1,1.101,1.099,1.1005', '2024-01-01T00:15:00Z,1.1005,1.102,1.1,1.1015'].join(
      '\n'
    );
    const result = parseCsvCandles(csv);
    expect(result.candles).toHaveLength(2);
    expect(result.notes.some((n) => n.includes('No recognizable header'))).toBe(true);
  });

  it('parses unix-seconds and unix-millisecond timestamps correctly', () => {
    const seconds = 1704067200; // 2024-01-01T00:00:00Z
    const csv = [
      'time,open,high,low,close',
      `${seconds},1.1,1.101,1.099,1.1005`,
      `${seconds * 1000 + 900000},1.1005,1.102,1.1,1.1015`, // ms, +15min
    ].join('\n');
    const result = parseCsvCandles(csv);
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0].time).toBe(seconds * 1000);
    expect(result.candles[1].time).toBe(seconds * 1000 + 900000);
  });

  it('skips malformed rows instead of aborting the whole parse', () => {
    const csv = [
      'time,open,high,low,close',
      '2024-01-01T00:00:00Z,1.1,1.101,1.099,1.1005',
      'not-a-real-row,,,',
      '2024-01-01T00:15:00Z,1.1005,1.102,1.1,1.1015',
    ].join('\n');
    const result = parseCsvCandles(csv);
    expect(result.candles).toHaveLength(2);
    expect(result.skippedRows).toBe(1);
  });

  it('sorts out-of-order rows chronologically', () => {
    const csv = [
      'time,open,high,low,close',
      '2024-01-01T00:15:00Z,1.1005,1.102,1.1,1.1015',
      '2024-01-01T00:00:00Z,1.1,1.101,1.099,1.1005',
    ].join('\n');
    const result = parseCsvCandles(csv);
    expect(result.candles[0].time).toBeLessThan(result.candles[1].time);
  });

  it('de-dupes rows with an identical timestamp', () => {
    const csv = [
      'time,open,high,low,close',
      '2024-01-01T00:00:00Z,1.1,1.101,1.099,1.1005',
      '2024-01-01T00:00:00Z,1.1,1.101,1.099,1.1005',
    ].join('\n');
    const result = parseCsvCandles(csv);
    expect(result.candles).toHaveLength(1);
    expect(result.skippedRows).toBe(1);
  });

  it('returns an empty result with a note for empty input', () => {
    const result = parseCsvCandles('');
    expect(result.candles).toHaveLength(0);
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

describe('CsvMarketProvider', () => {
  const csv = [
    'time,open,high,low,close,volume',
    '2024-01-01T00:00:00Z,1.1,1.101,1.099,1.1005,1000',
    '2024-01-01T00:15:00Z,1.1005,1.102,1.1,1.1015,1100',
    '2024-01-01T00:30:00Z,1.1015,1.103,1.101,1.1025,1200',
  ].join('\n');

  it('returns [] for an instrument with nothing loaded instead of throwing', () => {
    const provider = new CsvMarketProvider();
    expect(provider.getCandles('EURUSD', '15m', 10)).toEqual([]);
    expect(provider.hasData('EURUSD')).toBe(false);
  });

  it('loadCsv makes the parsed series available via getCandles/getFullSeries', () => {
    const provider = new CsvMarketProvider();
    const result = provider.loadCsv('EURUSD', csv);
    expect(result.candles).toHaveLength(3);
    expect(provider.hasData('EURUSD')).toBe(true);
    expect(provider.getFullSeries('EURUSD')).toHaveLength(3);
    expect(provider.getCandles('EURUSD', '15m', 2)).toHaveLength(2);
  });

  it('keeps series independent per instrument', () => {
    const provider = new CsvMarketProvider();
    provider.loadCsv('EURUSD', csv);
    expect(provider.hasData('GBPUSD')).toBe(false);
    expect(provider.loadedInstruments()).toEqual(['EURUSD']);
  });

  it('getSpread falls back to the instrument spec model (CSV has no recorded bid/ask)', () => {
    const provider = new CsvMarketProvider();
    provider.loadCsv('EURUSD', csv);
    expect(provider.getSpread('EURUSD')).toBeGreaterThan(0);
  });

  it('clear() removes a loaded series', () => {
    const provider = new CsvMarketProvider();
    provider.loadCsv('EURUSD', csv);
    provider.clear('EURUSD');
    expect(provider.hasData('EURUSD')).toBe(false);
  });
});
