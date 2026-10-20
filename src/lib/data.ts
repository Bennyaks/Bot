/**
 * lib/data
 * ----------
 * getCurrentSession() is the one genuinely live piece of logic here — used
 * by BreakoutStrategy to tag each real candidate with its trading session.
 * Everything else that used to live in this file (mock account stats, fake
 * session performance numbers, seeded rejection/trade/log lists) was
 * decorative data for the old demo dashboard, which has been removed —
 * see ARCHITECTURE_CHANGES.md for why.
 */
export function getCurrentSession(): 'Asian' | 'London' | 'NewYork' {
  const h = new Date().getUTCHours();
  if (h >= 0 && h < 8) return 'Asian';
  if (h >= 7 && h < 16) return 'London';
  return 'NewYork';
}
