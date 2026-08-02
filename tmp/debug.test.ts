import { describe, it } from 'vitest';
import { detectSwings, detectStructureBreaks } from '../../src/core/market/structure';
function c(open,high,low,close,i,volume=1000){return {time:i*60000, open, high, low, close, volume};}
describe('debug', () => {
  it('prints', () => {
    const prices = [1, 2, 3, 4, 5, 4, 3, 4, 5, 6, 5, 4, 3, 2, 1, 0.5];
    const candles = prices.map((p,i)=>c(p,p+0.1,p-0.1,p,i));
    const swings = detectSwings(candles, 2);
    console.log('swings', JSON.stringify(swings));
    const breaks = detectStructureBreaks(candles, swings);
    console.log('breaks', JSON.stringify(breaks));
  });
});
