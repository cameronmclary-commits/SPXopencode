import { useState, useMemo } from 'react'
import type { OptionRow } from '../types'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'

interface Props {
  date: string
  chain: OptionRow[]
  spotPrice: number
}

interface Leg {
  strike: number
  type: 'call' | 'put'
  quantity: number
  delta: number
  gamma: number
  entryAsk: number
  entryBid: number
}

interface Position {
  id: string
  callLegs: Leg[]
  putLegs: Leg[]
  netDelta: number
  totalGamma: number
  totalCost: number
  scenarios: { move: number; pnl: number }[]
  minPnl: number
  maxPnl: number
  convexity: number
  score: number
}

const R = 0.05
const T = 1 / 365
const DEFAULT_IV = 0.15

function cdf(x: number): number {
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429], p = 0.3275911
  const s = x < 0 ? -1 : 1; const ax = Math.abs(x)
  const t = 1 / (1 + p * ax)
  let y = 1
  for (let i = 4; i >= 0; i--) y = 1 - (a[i] * t + (i > 0 ? y : 0)) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + s * y)
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.SQRT2 / Math.sqrt(Math.PI)
}

function d1(S: number, K: number, T: number, r: number, sigma: number): number {
  return (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T))
}

function bsDelta(S: number, K: number, T: number, r: number, sigma: number, isCall: boolean): number {
  if (T <= 0) return isCall ? (S > K ? 1 : 0) : (S < K ? -1 : 0)
  return isCall ? cdf(d1(S, K, T, r, sigma)) : cdf(d1(S, K, T, r, sigma)) - 1
}

function bsGamma(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return 0
  const d = d1(S, K, T, r, sigma)
  return normPdf(d) / (S * sigma * Math.sqrt(T))
}

function extractAtmIv(chain: OptionRow[], spot: number): number {
  const near = chain.filter(r => Math.abs(r.strike - spot) / spot < 0.005 && r.mid > 0.05)
  if (near.length < 4) return DEFAULT_IV
  const call = near.find(r => r.type === 'call' && r.strike <= spot)
  const put = near.find(r => r.type === 'put' && r.strike >= spot)
  if (!call || !put || call.mid <= 0.01 || put.mid <= 0.01) return DEFAULT_IV
  const straddle = call.mid + put.mid
  let lo = 0.01, hi = 2.0
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2
    try {
      const d = d1(spot, call.strike, T, R, m)
      const d2 = d - m * Math.sqrt(T)
      const callP = spot * cdf(d) - call.strike * Math.exp(-R * T) * cdf(d2)
      const putP = put.strike * Math.exp(-R * T) * cdf(-(d - m * Math.sqrt(T))) - spot * cdf(-d)
      if (callP + putP > straddle) hi = m; else lo = m
    } catch { hi = m }
  }
  return Math.min(1.0, Math.max(0.05, (lo + hi) / 2))
}

function chainSurfacePrice(chain: OptionRow[], strike: number, type: 'call' | 'put', priceShift: number, useAsk: boolean, entrySpot: number): number {
  const movedSpot = entrySpot + priceShift
  const shifted = type === 'call' ? strike - priceShift : strike + priceShift
  const same = chain.filter(r => r.type === type).sort((a, b) => a.strike - b.strike)
  const getPrice = (r: OptionRow) => useAsk ? r.ask : r.bid
  if (same.length === 0) return Math.max(0, type === 'call' ? movedSpot - strike : strike - movedSpot)
  if (shifted <= same[0].strike) return Math.max(0, type === 'call' ? movedSpot - strike : strike - movedSpot)
  if (shifted >= same[same.length - 1].strike) return Math.max(0, type === 'call' ? movedSpot - strike : strike - movedSpot)
  let lo = 0, hi = same.length - 1
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (same[m].strike < shifted) lo = m; else hi = m }
  const t = (shifted - same[lo].strike) / (same[hi].strike - same[lo].strike)
  return getPrice(same[lo]) + t * (getPrice(same[hi]) - getPrice(same[lo]))
}

function scenarioPnl(legs: Leg[], chain: OptionRow[], spot: number, move: number): number {
  return legs.reduce((sum, leg) => {
    const exitVal = chainSurfacePrice(chain, leg.strike, leg.type, move, false, spot)
    return sum + leg.quantity * (exitVal - leg.entryAsk)
  }, 0)
}

function generateStructuredPosition(
  itmRow: EnhRow,
  otmRows: EnhRow[],
  chain: OptionRow[],
  spot: number,
): Position | null {
  const nOtm = otmRows.length
  let best = { callLegs: [] as Leg[], putLegs: [] as Leg[], netDelta: 0, totalGamma: 0, totalCost: 0 }
  let found = false
  let bestScore = -Infinity

  const isItmCall = itmRow.type === 'call'

  const search = (idx: number, chosen: number[]) => {
    if (idx === nOtm) {
      const callLegs: Leg[] = []
      const putLegs: Leg[] = []
      let delta = itmRow.delta
      let gamma = itmRow.gamma
      let cost = itmRow.ask
      const itmLeg: Leg = { strike: itmRow.strike, type: itmRow.type, quantity: 1, delta: itmRow.delta, gamma: itmRow.gamma, entryAsk: itmRow.ask, entryBid: itmRow.bid }
      if (isItmCall) callLegs.push(itmLeg); else putLegs.push(itmLeg)
      for (let i = 0; i < nOtm; i++) {
        const q = chosen[i]
        const r = otmRows[i]
        delta += q * r.delta
        gamma += q * r.gamma
        cost += q * r.ask
        const leg: Leg = { strike: r.strike, type: r.type, quantity: q, delta: r.delta, gamma: r.gamma, entryAsk: r.ask, entryBid: r.bid }
        if (r.type === 'call') callLegs.push(leg); else putLegs.push(leg)
      }
      if (gamma <= 0) return
      const absDelta = Math.abs(delta)
      if (absDelta > 0.5) return
      const dScore = absDelta + cost * 0.005
      if (dScore < bestScore || !found) {
        bestScore = dScore
        best = { callLegs, putLegs, netDelta: delta, totalGamma: gamma, totalCost: cost }
        found = true
      }
      return
    }
    const maxQ = idx === 0 ? 2 : 3
    for (let q = 1; q <= maxQ; q++) {
      chosen.push(q)
      search(idx + 1, chosen)
      chosen.pop()
    }
  }

  search(0, [])
  if (!found) return null

  const legs = [...best.callLegs, ...best.putLegs]
  const scenarios = [-10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10].map(move => ({
    move,
    pnl: scenarioPnl(legs, chain, spot, move),
  }))
  const minPnl = Math.min(...scenarios.map(s => s.pnl))
  const maxPnl = Math.max(...scenarios.map(s => s.pnl))
  const noLossAt5 = scenarios.find(s => Math.abs(s.move) === 5)!.pnl >= -0.5
  if (!noLossAt5) return null

  const pnlAt5 = scenarios.find(s => s.move === 5)!.pnl
  const pnlNeg5 = scenarios.find(s => s.move === -5)!.pnl
  const pnlAt10 = scenarios.find(s => s.move === 10)!.pnl
  const pnlNeg10 = scenarios.find(s => s.move === -10)!.pnl
  const symmetry5 = Math.abs(pnlAt5 - pnlNeg5)
  const symmetry10 = Math.abs(pnlAt10 - pnlNeg10)
  const avgPnl10 = (pnlAt10 + pnlNeg10) / 2

  const gammaEff = best.totalCost > 0.01 ? best.totalGamma / best.totalCost : 0
  const score = gammaEff * 100 - Math.abs(best.netDelta) * 3 - symmetry5 * 0.5 - symmetry10 * 0.3 + (avgPnl10 > 0 ? avgPnl10 : 0)

  return {
    id: `${isItmCall ? 'C' : 'P'}${itmRow.strike.toFixed(0)}_${nOtm}otm`,
    callLegs: best.callLegs,
    putLegs: best.putLegs,
    netDelta: best.netDelta,
    totalGamma: best.totalGamma,
    totalCost: best.totalCost,
    scenarios, minPnl, maxPnl,
    convexity: best.totalGamma,
    score,
  }
}

function getConsecutiveGroups<T extends { strike: number }>(arr: T[], k: number): T[][] {
  if (arr.length < k) return []
  const sorted = [...arr].sort((a, b) => a.strike - b.strike)
  const result: T[][] = []
  for (let i = 0; i <= sorted.length - k; i++) {
    const g = sorted.slice(i, i + k)
    const ok = g.every((_, j) => j === 0 || Math.abs(g[j].strike - g[j - 1].strike) === 5 || Math.abs(g[j].strike - g[j - 1].strike) === 0)
    if (ok) result.push(g)
  }
  return result
}

function generatePositions(allCalls: EnhRow[], allPuts: EnhRow[], chain: OptionRow[], spot: number, otmCount: number, maxResults: number): Position[] {
  const results: Position[] = []

  const itmCalls = allCalls.filter(r => r.strike < spot && r.delta > 0.5)
  for (const itm of itmCalls) {
    const otmPuts = allPuts
      .filter(r => r.strike > spot)
      .sort((a, b) => a.strike - b.strike)
    if (otmPuts.length < otmCount) continue
    for (const otms of getConsecutiveGroups(otmPuts, otmCount)) {
      const pos = generateStructuredPosition(itm, otms, chain, spot)
      if (pos) results.push(pos)
    }
  }

  const itmPuts = allPuts.filter(r => r.strike > spot && r.delta < -0.5)
  for (const itm of itmPuts) {
    const otmCalls = allCalls
      .filter(r => r.strike < spot)
      .sort((a, b) => a.strike - b.strike)
    if (otmCalls.length < otmCount) continue
    for (const otms of getConsecutiveGroups(otmCalls, otmCount)) {
      const pos = generateStructuredPosition(itm, otms, chain, spot)
      if (pos) results.push(pos)
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults)
}

interface EnhRow extends OptionRow {
  delta: number
  gamma: number
}

function enhanceRow(r: OptionRow, spot: number, iv: number): EnhRow {
  if (r.strike <= 0) return { ...r, delta: 0, gamma: 0 }
  const delta = bsDelta(spot, r.strike, T, R, iv, r.type === 'call')
  const gamma = bsGamma(spot, r.strike, T, R, iv)
  return { ...r, delta, gamma }
}

export default function TradeScanner({ date, chain, spotPrice }: Props) {
  const [otmCount, setOtmCount] = useState(2)
  const [maxResults, setMaxResults] = useState(20)
  const [minGammaFilter, setMinGammaFilter] = useState(0)
  const [maxCostFilter, setMaxCostFilter] = useState(20)
  const [selectedPos, setSelectedPos] = useState<string | null>(null)

  const calls = useMemo(() => {
    if (!spotPrice) return []
    const iv = extractAtmIv(chain, spotPrice)
    const range = spotPrice * 0.007
    return chain
      .filter(r => r.type === 'call' && r.strike > spotPrice - range && r.strike < spotPrice + range)
      .map(r => enhanceRow(r, spotPrice, iv))
      .sort((a, b) => a.strike - b.strike)
  }, [chain, spotPrice])

  const puts = useMemo(() => {
    if (!spotPrice) return []
    const iv = extractAtmIv(chain, spotPrice)
    const range = spotPrice * 0.007
    return chain
      .filter(r => r.type === 'put' && r.strike < spotPrice + range && r.strike > spotPrice - range)
      .map(r => enhanceRow(r, spotPrice, iv))
      .sort((a, b) => b.strike - a.strike)
  }, [chain, spotPrice])

  const positions = useMemo(() => {
    const results = generatePositions(calls, puts, chain, spotPrice, otmCount, maxResults * 5)
    return results.filter(p =>
      p.totalGamma >= minGammaFilter &&
      p.totalCost <= maxCostFilter
    ).slice(0, maxResults)
  }, [calls, puts, chain, spotPrice, otmCount, maxResults, minGammaFilter, maxCostFilter])

  const selected = positions.find(p => p.id === selectedPos)

  if (!date || chain.length === 0) {
    return <div className="text-center py-12 text-ztextdim">Select a session to scan for delta-neutral positions.</div>
  }

  return (
    <div className="space-y-4">
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Delta-Neutral Scanner</h3>
        <p className="text-xs text-ztextdim mb-4">
          Scanning {calls.length} calls and {puts.length} puts at spot <span className="text-white">${spotPrice.toFixed(2)}</span>.
        </p>
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">OTM legs per side:</label>
            <select value={otmCount} onChange={e => setOtmCount(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext">
              <option value={2}>2 OTM + 1 ITM</option>
              <option value={3}>3 OTM + 1 ITM</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Results:</label>
            <select value={maxResults} onChange={e => setMaxResults(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext">
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Min Gamma:</label>
            <input type="number" value={minGammaFilter} onChange={e => setMinGammaFilter(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" step={0.001} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Max Cost (pts):</label>
            <input type="number" value={maxCostFilter} onChange={e => setMaxCostFilter(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" />
          </div>
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="text-center py-8 text-ztextdim text-sm">No qualifying positions found.</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-zgray/30 border border-zborder rounded-lg overflow-hidden">
            <div className="px-4 py-2 text-xs font-semibold text-zcyan border-b border-zborder">
              Positions ({positions.length})
            </div>
            <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zdark/95 backdrop-blur-sm">
                  <tr className="text-ztextdim border-b border-zborder">
                    <th className="text-left px-2 py-1.5">Legs</th>
                    <th className="text-right px-2 py-1.5">D</th>
                    <th className="text-right px-2 py-1.5">G</th>
                    <th className="text-right px-2 py-1.5">Cost</th>
                    <th className="text-right px-2 py-1.5">-5</th>
                    <th className="text-right px-2 py-1.5">+5</th>
                    <th className="text-right px-2 py-1.5">-10</th>
                    <th className="text-right px-2 py-1.5">+10</th>
                    <th className="text-right px-2 py-1.5">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map(p => {
                    const p5 = p.scenarios.find(s => s.move === -5)!.pnl
                    const p5p = p.scenarios.find(s => s.move === 5)!.pnl
                    const p10 = p.scenarios.find(s => s.move === -10)!.pnl
                    const p10p = p.scenarios.find(s => s.move === 10)!.pnl
                    return (
                      <tr key={p.id} onClick={() => setSelectedPos(selectedPos === p.id ? null : p.id)}
                        className={`border-b border-zborder/50 cursor-pointer transition-colors ${selectedPos === p.id ? 'bg-zcyan/10' : 'hover:bg-zgray/20'}`}>
                        <td className="px-2 py-1.5 font-mono text-xs">
                          <span className="text-zgreen">{p.callLegs.map(l => `${l.strike.toFixed(0)}${l.quantity > 1 ? `x${l.quantity}` : ''}`).join('+')}</span>
                          {' / '}
                          <span className="text-zred">{p.putLegs.map(l => `${l.strike.toFixed(0)}${l.quantity > 1 ? `x${l.quantity}` : ''}`).join('+')}</span>
                        </td>
                        <td className={`text-right px-2 py-1.5 font-mono ${Math.abs(p.netDelta) < 0.05 ? 'text-zgreen' : 'text-zyellow'}`}>{p.netDelta.toFixed(3)}</td>
                        <td className="text-right px-2 py-1.5 font-mono text-zcyan">{p.totalGamma.toFixed(4)}</td>
                        <td className="text-right px-2 py-1.5 font-mono text-ztext">{p.totalCost.toFixed(2)}</td>
                        <td className={`text-right px-2 py-1.5 font-mono ${p5 >= 0 ? 'text-zgreen' : 'text-zred'}`}>{p5.toFixed(2)}</td>
                        <td className={`text-right px-2 py-1.5 font-mono ${p5p >= 0 ? 'text-zgreen' : 'text-zred'}`}>{p5p.toFixed(2)}</td>
                        <td className={`text-right px-2 py-1.5 font-mono ${p10 >= 0 ? 'text-zgreen' : 'text-zred'}`}>{p10.toFixed(2)}</td>
                        <td className={`text-right px-2 py-1.5 font-mono ${p10p >= 0 ? 'text-zgreen' : 'text-zred'}`}>{p10p.toFixed(2)}</td>
                        <td className="text-right px-2 py-1.5 font-mono text-zpurple">{p.score.toFixed(1)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {selected && (
            <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
              <h3 className="text-sm font-medium text-ztextdim mb-3">Position Detail</h3>
              <div className="space-y-3 text-xs">
                <div>
                  <div className="text-ztextdim mb-1">Calls</div>
                  {selected.callLegs.map(l => (
                    <div key={`${l.strike}-${l.type}`} className="flex justify-between text-zgreen font-mono">
                      <span>${l.strike.toFixed(0)} x{l.quantity}</span>
                      <span>D={l.delta.toFixed(3)} G={l.gamma.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="text-ztextdim mb-1">Puts</div>
                  {selected.putLegs.map(l => (
                    <div key={`${l.strike}-${l.type}`} className="flex justify-between text-zred font-mono">
                      <span>${l.strike.toFixed(0)} x{l.quantity}</span>
                      <span>D={l.delta.toFixed(3)} G={l.gamma.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
                <div className="border-t border-zborder pt-2 space-y-1">
                  <Row label="Net Delta" value={selected.netDelta.toFixed(4)} />
                  <Row label="Total Gamma" value={selected.totalGamma.toFixed(4)} color="text-zcyan" />
                  <Row label="Total Cost" value={`${selected.totalCost.toFixed(2)} pts`} />
                  <Row label="Min P&L" value={`${selected.minPnl.toFixed(2)}`} color={selected.minPnl >= 0 ? 'text-zgreen' : 'text-zred'} />
                  <Row label="Max P&L" value={`${selected.maxPnl.toFixed(2)}`} color={selected.maxPnl >= 0 ? 'text-zgreen' : 'text-zred'} />
                </div>
                <div className="border-t border-zborder pt-2">
                  <div className="text-ztextdim mb-2">P&L Scenario Chart</div>
                  <ResponsiveContainer width="100%" height={160}>
                    <AreaChart data={selected.scenarios}>
                      <defs><linearGradient id="scenarioGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#a855f7" stopOpacity={0.3} /><stop offset="100%" stopColor="#a855f7" stopOpacity={0} /></linearGradient></defs>
                      <XAxis dataKey="move" tick={{ fontSize: 10, fill: '#6b7280' }} />
                      <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
                      <ReferenceLine y={0} stroke="#2a2a4a" />
                      <ReferenceLine x={0} stroke="#2a2a4a" />
                      <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 6, fontSize: 11 }} formatter={(v) => [`${Number(v).toFixed(2)}`, 'P&L']} labelFormatter={l => `Move: ${l} pts`} />
                      <Area type="monotone" dataKey="pnl" stroke="#a855f7" fill="url(#scenarioGrad)" strokeWidth={2} dot />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-ztextdim">{label}</span>
      <span className={`font-mono ${color || 'text-white'}`}>{value}</span>
    </div>
  )
}