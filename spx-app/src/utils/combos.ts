import type { OptionRow } from '../types'
import { surfacePrice, numericDelta, getConsecutiveGroups } from './pricing'

export interface ComboLeg {
  strike: number
  type: 'call' | 'put'
  quantity: number
  entryAsk: number
  entryBid: number
  conid?: number
}

export interface ComboResult {
  legs: ComboLeg[]
  cost: number
  score: number
  pnlPos: number
  pnlNeg: number
}

export function evalCombo(
  itm: OptionRow,
  otms: OptionRow[],
  chain: OptionRow[],
  spot: number,
  maxCost: number,
  templateMove: number,
  minPnl: number,
  minDelta: number,
): ComboResult | null {
  const ask = (r: OptionRow) => surfacePrice(chain, r.strike, r.type, 0, true, spot)
  const bid = (r: OptionRow, move: number) => surfacePrice(chain, r.strike, r.type, move, false, spot)

  let best: ComboResult | null = null
  let bestScore = -Infinity
  const n = otms.length

  const search = (idx: number, chosen: number[]) => {
    if (idx === n) {
      let cost = ask(itm)
      const legs: ComboLeg[] = [{
        strike: itm.strike, type: itm.type, quantity: 1,
        entryAsk: ask(itm), entryBid: bid(itm, 0), conid: itm.conid,
      }]
      for (let i = 0; i < n; i++) {
        const q = chosen[i]; const r = otms[i]; const a = ask(r)
        cost += q * a
        legs.push({
          strike: r.strike, type: r.type, quantity: q,
          entryAsk: a, entryBid: bid(r, 0), conid: r.conid,
        })
      }
      if (cost > maxCost) return
      if (minDelta > 0) {
        for (const l of legs) {
          if (Math.abs(numericDelta(chain, l.strike, l.type, spot, spot)) < minDelta) return
        }
      }
      const pnLat = (move: number) => legs.reduce(
        (s, l) => s + l.quantity * surfacePrice(chain, l.strike, l.type, move, false, spot), 0
      )
      const pnlPos = pnLat(templateMove) - cost
      const pnlNeg = pnLat(-templateMove) - cost
      if (pnlPos < minPnl || pnlNeg < minPnl) return
      const sc = Math.min(pnlPos, pnlNeg) / (cost + 0.01) * 100
      if (sc > bestScore) {
        bestScore = sc
        best = { legs, cost, score: sc, pnlPos, pnlNeg }
      }
      return
    }
    for (let q = 1; q <= (idx === 0 ? 2 : 3); q++) {
      chosen.push(q)
      search(idx + 1, chosen)
      chosen.pop()
    }
  }
  search(0, [])
  return best
}

export function findBestCombo(
  chain: OptionRow[],
  spot: number,
  maxCost: number,
  templateMove: number,
  minPnl: number,
  minDelta: number,
  maxResults: number = 1,
): ComboResult[] {
  const range = spot * 0.007
  const calls = chain.filter(r => r.type === 'call' && r.strike > spot - range && r.strike < spot + range)
    .sort((a, b) => a.strike - b.strike)
  const puts = chain.filter(r => r.type === 'put' && r.strike < spot + range && r.strike > spot - range)
    .sort((a, b) => a.strike - b.strike)
  const results: ComboResult[] = []

  for (const otmCount of [2, 3]) {
    for (const itm of calls.filter(r => r.strike < spot)) {
      const otms = puts.filter(r => r.strike > itm.strike && r.strike < spot)
      if (otms.length < otmCount) continue
      for (const g of getConsecutiveGroups(otms, otmCount)) {
        const r = evalCombo(itm, g, chain, spot, maxCost, templateMove, minPnl, minDelta)
        if (r) results.push(r)
      }
    }
    for (const itm of puts.filter(r => r.strike > spot)) {
      const otms = calls.filter(r => r.strike < itm.strike && r.strike > spot)
      if (otms.length < otmCount) continue
      for (const g of getConsecutiveGroups(otms, otmCount)) {
        const r = evalCombo(itm, g, chain, spot, maxCost, templateMove, minPnl, minDelta)
        if (r) results.push(r)
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults)
}
