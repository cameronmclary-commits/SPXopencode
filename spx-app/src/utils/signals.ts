import type { ChainSnapshot } from '../types'
import { surfacePrice } from './pricing'

export function comboMidCost(
  legs: { strike: number; type: 'call' | 'put'; quantity: number }[],
  snapshot: ChainSnapshot
): number {
  return legs.reduce((sum, leg) => {
    const bid = surfacePrice(snapshot.chain, leg.strike, leg.type, 0, false)
    const ask = surfacePrice(snapshot.chain, leg.strike, leg.type, 0, true)
    return sum + leg.quantity * (bid + ask) / 2
  }, 0)
}

export function comboCostHistory(
  legs: { strike: number; type: 'call' | 'put'; quantity: number }[],
  snapshots: ChainSnapshot[]
): { time: string; cost: number }[] {
  return snapshots.map(s => ({ time: s.time, cost: comboMidCost(legs, s) }))
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
