import { useState, useMemo } from 'react'
import type { OptionRow } from '../types'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'

interface Props {
  date: string
  chain: OptionRow[]
  spotPrice: number
}

interface Leg {
  strike: number; type: 'call' | 'put'; quantity: number
  entryAsk: number; entryBid: number
}

interface Position {
  id: string
  callLegs: Leg[]; putLegs: Leg[]
  totalCost: number
  scenarios: { move: number; pnl: number }[]
  minPnl: number; maxPnl: number
  score: number
}

function chainSurfacePrice(chain: OptionRow[], strike: number, type: 'call' | 'put', priceShift: number, useAsk: boolean, entrySpot: number): number {
  const shifted = type === 'call' ? strike - priceShift : strike + priceShift
  const same = chain.filter(r => r.type === type).sort((a, b) => a.strike - b.strike)
  const getPrice = (r: OptionRow) => useAsk ? r.ask : r.bid
  if (same.length === 0) return Math.max(0.01, type === 'call' ? entrySpot + priceShift - strike : strike - (entrySpot + priceShift))
  if (shifted <= same[0].strike) return Math.max(0.01, getPrice(same[0]))
  if (shifted >= same[same.length - 1].strike) return Math.max(0.01, getPrice(same[same.length - 1]))
  let lo = 0, hi = same.length - 1
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (same[m].strike < shifted) lo = m; else hi = m }
  const t = (shifted - same[lo].strike) / (same[hi].strike - same[lo].strike)
  return getPrice(same[lo]) + t * (getPrice(same[hi]) - getPrice(same[lo]))
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

function generateStructuredPosition(
  itmRow: OptionRow,
  otmRows: OptionRow[],
  chain: OptionRow[],
  spot: number,
  templateMove: number,
  minPnl: number,
): Position | null {
  const nOtm = otmRows.length
  let bestCallLegs: Leg[] = []
  let bestPutLegs: Leg[] = []
  let bestCost = 0
  let bestScore = -Infinity

  const ask = (r: OptionRow) => chainSurfacePrice(chain, r.strike, r.type, 0, true, spot)
  const pnLat = (legs: Leg[], move: number) => legs.reduce((s, l) => s + l.quantity * chainSurfacePrice(chain, l.strike, l.type, move, false, spot), 0)

  const search = (idx: number, chosen: number[]) => {
    if (idx === nOtm) {
      const callLegs: Leg[] = []
      const putLegs: Leg[] = []
      let cost = ask(itmRow)
      const itmLeg: Leg = { strike: itmRow.strike, type: itmRow.type, quantity: 1, entryAsk: cost, entryBid: chainSurfacePrice(chain, itmRow.strike, itmRow.type, 0, false, spot) }
      ;(itmRow.type === 'call' ? callLegs : putLegs).push(itmLeg)
      for (let i = 0; i < nOtm; i++) {
        const q = chosen[i]; const r = otmRows[i]; const a = ask(r)
        cost += q * a
        const leg: Leg = { strike: r.strike, type: r.type, quantity: q, entryAsk: a, entryBid: chainSurfacePrice(chain, r.strike, r.type, 0, false, spot) }
        ;(r.type === 'call' ? callLegs : putLegs).push(leg)
      }
      const legs = [...callLegs, ...putLegs]
      const pnlPos = pnLat(legs, templateMove) - cost
      const pnlNeg = pnLat(legs, -templateMove) - cost
      if (pnlPos < minPnl || pnlNeg < minPnl) return
      const half = templateMove / 2
      const pnlHalfPos = pnLat(legs, half) - cost
      const pnlHalfNeg = pnLat(legs, -half) - cost
      const sc = Math.min(pnlPos, pnlNeg) / (cost + 0.01) * 100 + (pnlHalfPos > 0 && pnlHalfNeg > 0 ? 5 : 0)
      if (sc > bestScore) { bestCallLegs = callLegs; bestPutLegs = putLegs; bestCost = cost; bestScore = sc }
      return
    }
    for (let q = 1; q <= (idx === 0 ? 2 : 3); q++) { chosen.push(q); search(idx + 1, chosen); chosen.pop() }
  }
  search(0, [])
  if (bestScore === -Infinity) return null
  const legs = [...bestCallLegs, ...bestPutLegs]
  const scenarios = [-15, -10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10, 15].map(move => ({ move, pnl: pnLat(legs, move) - bestCost }))
  const pnls = scenarios.map(s => s.pnl)
  return {
    id: `${itmRow.type === 'call' ? 'C' : 'P'}${itmRow.strike.toFixed(0)}_${nOtm}otm`,
    callLegs: bestCallLegs, putLegs: bestPutLegs,
    totalCost: bestCost,
    scenarios, minPnl: Math.min(...pnls), maxPnl: Math.max(...pnls),
    score: bestScore,
  }
}

function generatePositions(chain: OptionRow[], spot: number, otmCount: number, maxResults: number, templateMove: number, minPnl: number): Position[] {
  const range = spot * 0.007
  const calls = chain.filter(r => r.type === 'call' && r.strike > spot - range && r.strike < spot + range).sort((a, b) => a.strike - b.strike)
  const puts = chain.filter(r => r.type === 'put' && r.strike < spot + range && r.strike > spot - range).sort((a, b) => a.strike - b.strike)
  const results: Position[] = []

  for (const itm of calls.filter(r => r.strike < spot)) {
    const otms = puts.filter(r => r.strike > spot)
    if (otms.length < otmCount) continue
    for (const g of getConsecutiveGroups(otms, otmCount)) {
      const pos = generateStructuredPosition(itm, g, chain, spot, templateMove, minPnl)
      if (pos) results.push(pos)
    }
  }

  for (const itm of puts.filter(r => r.strike > spot)) {
    const otms = calls.filter(r => r.strike < spot)
    if (otms.length < otmCount) continue
    for (const g of getConsecutiveGroups(otms, otmCount)) {
      const pos = generateStructuredPosition(itm, g, chain, spot, templateMove, minPnl)
      if (pos) results.push(pos)
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults)
}

export default function TradeScanner({ date, chain, spotPrice }: Props) {
  const [otmCount, setOtmCount] = useState(2)
  const [maxResults, setMaxResults] = useState(20)
  const [maxCostFilter, setMaxCostFilter] = useState(20)
  const [templateMove, setTemplateMove] = useState(10)
  const [minPnl, setMinPnl] = useState(0)
  const [selectedPos, setSelectedPos] = useState<string | null>(null)

  const positions = useMemo(() => {
    if (!spotPrice || chain.length === 0) return []
    const results = generatePositions(chain, spotPrice, otmCount, maxResults * 5, templateMove, minPnl)
    return results.filter(p => p.totalCost <= maxCostFilter).slice(0, maxResults)
  }, [chain, spotPrice, otmCount, maxResults, maxCostFilter, templateMove, minPnl])

  const selected = positions.find(p => p.id === selectedPos)

  if (!date || chain.length === 0) {
    return <div className="text-center py-12 text-ztextdim">Select a session to scan for ±10 profit combos.</div>
  }

  return (
    <div className="space-y-4">
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">±10 Profit Combo Scanner</h3>
        <p className="text-xs text-ztextdim mb-4">
          Scanning {chain.filter(r => r.type === 'call').length} calls and {chain.filter(r => r.type === 'put').length} puts at <span className="text-white">${spotPrice.toFixed(2)}</span>.
        </p>
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">OTM legs:</label>
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
            <label className="text-xs text-ztextdim">Max Cost (pts):</label>
            <input type="number" value={maxCostFilter} onChange={e => setMaxCostFilter(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Template (pts):</label>
            <input type="number" value={templateMove} onChange={e => setTemplateMove(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" step={2.5} min={5} max={20} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Min P&L (pts):</label>
            <input type="number" value={minPnl} onChange={e => setMinPnl(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" step={0.1} min={0} max={5} />
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
                      <span>@{l.entryAsk.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="text-ztextdim mb-1">Puts</div>
                  {selected.putLegs.map(l => (
                    <div key={`${l.strike}-${l.type}`} className="flex justify-between text-zred font-mono">
                      <span>${l.strike.toFixed(0)} x{l.quantity}</span>
                      <span>@{l.entryAsk.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                <div className="border-t border-zborder pt-2 space-y-1">
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
