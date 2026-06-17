import type { ChainSnapshot } from '../types'
import { surfacePrice } from './pricing'

export function comboAskCost(
  legs: { strike: number; type: 'call' | 'put'; quantity: number }[],
  snapshot: ChainSnapshot
): number {
  return legs.reduce((sum, leg) => {
    return sum + leg.quantity * surfacePrice(snapshot.chain, leg.strike, leg.type, 0, true)
  }, 0)
}

export function comboBidValue(
  legs: { strike: number; type: 'call' | 'put'; quantity: number }[],
  snapshot: ChainSnapshot
): number {
  return legs.reduce((sum, leg) => {
    return sum + leg.quantity * surfacePrice(snapshot.chain, leg.strike, leg.type, 0, false)
  }, 0)
}

export function comboCostHistory(
  legs: { strike: number; type: 'call' | 'put'; quantity: number }[],
  snapshots: ChainSnapshot[]
): { time: string; cost: number }[] {
  return snapshots.map(s => ({ time: s.time, cost: comboAskCost(legs, s) }))
}

export function rollingZscore(
  values: number[],
  lookback: number
): (number | null)[] {
  const result: (number | null)[] = []
  for (let i = 0; i < values.length; i++) {
    if (i < lookback) {
      result.push(null)
      continue
    }
    const window = values.slice(i - lookback, i)
    const mean = window.reduce((s, v) => s + v, 0) / lookback
    const n = lookback
    const std = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
    result.push(std > 0 ? (values[i] - mean) / std : 0)
  }
  return result
}
