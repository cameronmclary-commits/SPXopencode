import { useState, useMemo } from 'react'
import type { OptionRow } from '../types'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { findBestCombo, type ComboLeg } from '../utils/combos'
import { surfacePrice } from '../utils/pricing'

interface Props {
  date: string
  chain: OptionRow[]
  spotPrice: number
}

interface ScenarioLeg {
  strike: number; type: 'call' | 'put'; quantity: number
  entryAsk: number; entryBid: number
}

interface Position {
  id: string
  callLegs: ScenarioLeg[]; putLegs: ScenarioLeg[]
  totalCost: number
  scenarios: { move: number; pnl: number }[]
  minPnl: number; maxPnl: number
  score: number
}

function computeScenarios(legs: ComboLeg[], chain: OptionRow[], cost: number) {
  const moves = [-15, -10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10, 15]
  return moves.map(move => {
    const pnl = legs.reduce((s, l) => {
      return s + l.quantity * surfacePrice(chain, l.strike, l.type, move, false)
    }, 0) - cost
    return { move, pnl }
  })
}

function resultToPosition(r: { legs: ComboLeg[]; cost: number; score: number }, chain: OptionRow[]): Position {
  const callLegs = r.legs.filter(l => l.type === 'call').map(l => ({
    strike: l.strike, type: l.type as 'call', quantity: l.quantity,
    entryAsk: l.entryAsk, entryBid: l.entryBid,
  }))
  const putLegs = r.legs.filter(l => l.type === 'put').map(l => ({
    strike: l.strike, type: l.type as 'put', quantity: l.quantity,
    entryAsk: l.entryAsk, entryBid: l.entryBid,
  }))
  const scenarios = computeScenarios(r.legs, chain, r.cost)
  const pnls = scenarios.map(s => s.pnl)
  const itm = callLegs.length === 1 ? callLegs[0] : putLegs[0]
  return {
    id: `${itm.type === 'call' ? 'C' : 'P'}${itm.strike.toFixed(0)}_${r.legs.length - 1}otm`,
    callLegs, putLegs,
    totalCost: r.cost,
    scenarios, minPnl: Math.min(...pnls), maxPnl: Math.max(...pnls),
    score: r.score,
  }
}

export default function TradeScanner({ date, chain, spotPrice }: Props) {
  const [maxResults, setMaxResults] = useState(20)
  const [maxCostFilter, setMaxCostFilter] = useState(20)
  const [templateMove, setTemplateMove] = useState(10)
  const [minPnl, setMinPnl] = useState(0)
  const [minSideDelta, setMinSideDelta] = useState(0.5)
  const [minBalance, setMinBalance] = useState(0.85)
  const [minGap, setMinGap] = useState(15)
  const [maxStep, setMaxStep] = useState(10)
  const [selectedPos, setSelectedPos] = useState<string | null>(null)

  const positions = useMemo(() => {
    if (!spotPrice || chain.length === 0) return []
    const results = findBestCombo(chain, spotPrice, maxCostFilter, templateMove, minPnl, minSideDelta, minBalance, minGap, maxStep, maxResults * 5)
    return results.map(r => resultToPosition(r, chain)).slice(0, maxResults)
  }, [chain, spotPrice, maxResults, maxCostFilter, templateMove, minPnl, minSideDelta, minBalance, minGap, maxStep])

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
            <label className="text-xs text-ztextdim">Results:</label>
            <select value={maxResults} onChange={e => setMaxResults(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext">
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Max Cost (pts):</label>
            <input type="number" value={maxCostFilter} onChange={e => setMaxCostFilter(Number(e.target.value))} onFocus={e => e.target.select()} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Template (pts):</label>
            <input type="number" value={templateMove} onChange={e => setTemplateMove(Number(e.target.value))} onFocus={e => e.target.select()} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" step={2.5} min={5} max={20} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Min P&L (pts):</label>
            <input type="number" value={minPnl} onChange={e => setMinPnl(Number(e.target.value))} onFocus={e => e.target.select()} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" step={0.1} min={0} max={5} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Min Side Delta:</label>
            <input type="number" value={minSideDelta} onChange={e => setMinSideDelta(Number(e.target.value))} onFocus={e => e.target.select()} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" step={0.05} min={0} max={1} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Min Balance:</label>
            <input type="number" value={minBalance} onChange={e => setMinBalance(Number(e.target.value))} onFocus={e => e.target.select()} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" step={0.05} min={0} max={1} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Min Gap:</label>
            <input type="number" value={minGap} onChange={e => setMinGap(Number(e.target.value))} onFocus={e => e.target.select()} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" step={5} min={0} max={50} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Max Step:</label>
            <input type="number" value={maxStep} onChange={e => setMaxStep(Number(e.target.value))} onFocus={e => e.target.select()} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" step={1} min={1} max={50} />
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
