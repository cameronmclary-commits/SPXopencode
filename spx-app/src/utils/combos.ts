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
  pnl5Pos: number
  pnl5Neg: number
}

export function evalCombo(
  itm: OptionRow,
  otms: OptionRow[],
  chain: OptionRow[],
  spot: number,
  maxCost: number,
  templateMove: number,
  minPnl10: number,
  minPnl: number,
  minPnlHalf: number,
  minSideDelta: number,
  minBalance: number,
  minGap: number,
  minSpotGap: number,
  maxStep: number,
): ComboResult | null {
  const ask = (r: OptionRow) => surfacePrice(chain, r.strike, r.type, 0, true)
  const bid = (r: OptionRow, move: number) => surfacePrice(chain, r.strike, r.type, move, false)

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
      let callDelta = 0, putDelta = 0
      for (const l of legs) {
        const d = numericDelta(chain, l.strike, l.type, spot, spot)
        if (l.type === 'call') callDelta += d
        else putDelta += Math.abs(d)
      }
      if (Math.min(callDelta, putDelta) < minSideDelta) return
      if (minBalance > 0) {
        const minSide = Math.min(callDelta, putDelta)
        const maxSide = Math.max(callDelta, putDelta)
        if (maxSide > 0 && minSide / maxSide < minBalance) return
      }
      if (minGap > 0) {
        const avgOtm = otms.reduce((s, r) => s + r.strike, 0) / otms.length
        const gap = itm.type === 'call' ? avgOtm - itm.strike : itm.strike - avgOtm
        if (gap < minGap) return
      }
      if (minSpotGap > 0) {
        const nearestOtmStrike = otms[itm.type === 'call' ? n - 1 : 0].strike
        const spotGap = itm.type === 'call' ? spot - nearestOtmStrike : nearestOtmStrike - spot
        if (spotGap < minSpotGap) return
      }
      const pnLat = (move: number) => legs.reduce(
        (s, l) => s + l.quantity * surfacePrice(chain, l.strike, l.type, move, false), 0
      )
      const pnlPos = pnLat(templateMove) - cost
      const pnlNeg = pnLat(-templateMove) - cost
      const halfMove = templateMove / 2
      const pnl5Pos = pnLat(halfMove) - cost
      const pnl5Neg = pnLat(-halfMove) - cost
      if (Math.max(pnlPos, pnlNeg) < minPnl10 || Math.min(pnlPos, pnlNeg) < minPnl) return
      if (pnl5Pos < minPnlHalf || pnl5Neg < minPnlHalf) return
      if (maxStep > 0 && templateMove / Math.min(pnlPos, pnlNeg) > maxStep) return
      const sc = Math.min(pnlPos, pnlNeg, pnl5Pos, pnl5Neg)
      if (sc > bestScore || (sc === bestScore && cost < (best?.cost ?? Infinity))) {
        bestScore = sc
        best = { legs, cost, score: sc, pnlPos, pnlNeg, pnl5Pos, pnl5Neg }
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
  minPnl10: number,
  minPnl: number,
  minPnlHalf: number,
  minSideDelta: number,
  minBalance: number,
  minGap: number,
  minSpotGap: number,
  maxStep: number,
  maxResults: number = 1,
): ComboResult[] {
  const range = spot * 0.007
  const calls = chain.filter(r => r.type === 'call' && r.strike > spot - range && r.strike < spot + range)
    .sort((a, b) => a.strike - b.strike)
  const puts = chain.filter(r => r.type === 'put' && r.strike < spot + range && r.strike > spot - range)
    .sort((a, b) => a.strike - b.strike)
  const results: ComboResult[] = []

  for (const itm of calls.filter(r => r.strike < spot)) {
    const otms = puts.filter(r => r.strike > itm.strike && r.strike < spot)
    if (otms.length < 2) continue
    for (const g of getConsecutiveGroups(otms, 2)) {
      const r = evalCombo(itm, g, chain, spot, maxCost, templateMove, minPnl10, minPnl, minPnlHalf, minSideDelta, minBalance, minGap, minSpotGap, maxStep)
      if (r) results.push(r)
    }
  }
  for (const itm of puts.filter(r => r.strike > spot)) {
    const otms = calls.filter(r => r.strike < itm.strike && r.strike > spot)
    if (otms.length < 2) continue
    for (const g of getConsecutiveGroups(otms, 2)) {
      const r = evalCombo(itm, g, chain, spot, maxCost, templateMove, minPnl10, minPnl, minPnlHalf, minSideDelta, minBalance, minGap, minSpotGap, maxStep)
      if (r) results.push(r)
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults)
}
