import type { OptionRow } from '../types'

export function surfacePrice(
  chain: OptionRow[],
  strike: number,
  type: 'call' | 'put',
  priceShift: number,
  useAsk: boolean,
  entrySpot: number,
): number {
  const shifted = strike - priceShift
  const same = chain.filter(r => r.type === type).sort((a, b) => a.strike - b.strike)
  const getPrice = (r: OptionRow) => useAsk ? r.ask : r.bid

  if (same.length === 0) {
    return Math.max(0.01, type === 'call'
      ? entrySpot + priceShift - strike
      : strike - (entrySpot + priceShift))
  }
  if (shifted <= same[0].strike) return Math.max(0.01, getPrice(same[0]))
  if (shifted >= same[same.length - 1].strike) return Math.max(0.01, getPrice(same[same.length - 1]))

  let lo = 0, hi = same.length - 1
  while (hi - lo > 1) {
    const m = Math.floor((lo + hi) / 2)
    if (same[m].strike < shifted) lo = m; else hi = m
  }
  const t = (shifted - same[lo].strike) / (same[hi].strike - same[lo].strike)
  return getPrice(same[lo]) + t * (getPrice(same[hi]) - getPrice(same[lo]))
}

export function surfaceMid(
  chain: OptionRow[],
  strike: number,
  type: 'call' | 'put',
  priceShift: number,
  baseSpot: number,
): number {
  const bid = surfacePrice(chain, strike, type, priceShift, false, baseSpot)
  const ask = surfacePrice(chain, strike, type, priceShift, true, baseSpot)
  return (bid + ask) / 2
}

export function numericDelta(
  chain: OptionRow[],
  strike: number,
  type: 'call' | 'put',
  spot: number,
  baseSpot: number,
): number {
  const ps = spot - baseSpot
  const up = surfaceMid(chain, strike, type, ps + 1, baseSpot)
  const dn = surfaceMid(chain, strike, type, ps - 1, baseSpot)
  return (up - dn) / 2
}

export function getConsecutiveGroups<T extends { strike: number }>(arr: T[], k: number): T[][] {
  if (arr.length < k) return []
  const sorted = [...arr].sort((a, b) => a.strike - b.strike)
  const r: T[][] = []
  for (let i = 0; i <= sorted.length - k; i++) {
    const g = sorted.slice(i, i + k)
    const ok = g.every((_, j) =>
      j === 0 ||
      Math.abs(g[j].strike - g[j - 1].strike) === 5 ||
      Math.abs(g[j].strike - g[j - 1].strike) === 0
    )
    if (ok) r.push(g)
  }
  return r
}
