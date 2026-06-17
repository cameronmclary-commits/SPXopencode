import { useState, useEffect, useCallback } from 'react'
import type { OptionRow } from '../types'
import { findBestCombo } from '../utils/combos'
import type { ComboLeg } from '../utils/combos'
import { ParamInput, MetricCard } from './shared/UI'

interface LiveData {
  date: string
  spot: number
  pricePath: { time: string; price: number }[]
  openingChain: OptionRow[]
  snapshots: { time: string; chain: OptionRow[] }[]
}

interface ComboDisplay {
  legs: string
  cost: number
  score: number
  pnl5Pos: number
  pnl5Neg: number
  pnl10Pos: number
  pnl10Neg: number
  side: 'call' | 'put'
}

interface PaperPosition {
  id: number
  entryTime: string
  entrySpot: number
  legs: ComboLeg[]
  cost: number
  currentValue: number
  pnl: number
  status: 'open' | 'tp' | 'sl'
  exitTime?: string
  exitSpot?: number
}

interface ComboScanEntry {
  time: string
  spot: number
  total: number
  bestLegs: string
  bestCost: number
  bestScore: number
  bestPnl10Pos: number
  bestPnl10Neg: number
  bestPnl5Pos: number
  bestPnl5Neg: number
  side: string
}

export default function LiveAnalysis() {
  const [liveData, setLiveData] = useState<LiveData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [templateMove, setTemplateMove] = useState(10)
  const [minPnl10, setMinPnl10] = useState(1)
  const [minPnl, setMinPnl] = useState(0.5)
  const [minPnlHalf, setMinPnlHalf] = useState(0)
  const [minSideDelta, setMinSideDelta] = useState(0.5)
  const [minBalance, setMinBalance] = useState(0.85)
  const [minGap, setMinGap] = useState(15)
  const [minSpotGap, setMinSpotGap] = useState(10)
  const [maxStep, setMaxStep] = useState(10)
  const [maxCost, setMaxCost] = useState(70)

  const [comboResults, setComboResults] = useState<ComboDisplay[]>([])
  const [refreshing, setRefreshing] = useState(false)

  // Paper trading state
  const [autoTrade, setAutoTrade] = useState(false)
  const [tp, setTp] = useState(0.8)
  const [sl, setSl] = useState(4)
  const [positions, setPositions] = useState<PaperPosition[]>([])
  const [comboHistory, setComboHistory] = useState<ComboScanEntry[]>([])

  const fetchLive = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/live/yahoo')
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setLiveData(data)

      const chain = data.openingChain || []
      const spot = data.spot
      if (!chain.length || !spot) return

      const results = findBestCombo(chain, spot, maxCost, templateMove, minPnl10, minPnl, minPnlHalf, minSideDelta, minBalance, minGap, minSpotGap, maxStep, 20)

      const display: ComboDisplay[] = results.map(r => {
        const legStr = r.legs.map(l => `${l.type[0]}${l.strike}${l.quantity > 1 ? 'x' + l.quantity : ''}`).join('+')
        const itmType = r.legs[0].type
        return {
          legs: legStr,
          cost: r.cost,
          score: r.score,
          pnl5Pos: r.pnl5Pos,
          pnl5Neg: r.pnl5Neg,
          pnl10Pos: r.pnlPos,
          pnl10Neg: r.pnlNeg,
          side: itmType,
        }
      })
      setComboResults(display)

      // Record all qualifying combos from this scan
      if (results.length) {
        const timeStr = data.pricePath[data.pricePath.length - 1]?.time || '?'
        const best = results[0]
        const bestLegStr = best.legs.map(l => `${l.type[0]}${l.strike}${l.quantity > 1 ? 'x' + l.quantity : ''}`).join('+')
        setComboHistory(prev => [{
          time: timeStr,
          spot,
          total: results.length,
          bestLegs: bestLegStr,
          bestCost: best.cost,
          bestScore: best.score,
          bestPnl10Pos: best.pnlPos,
          bestPnl10Neg: best.pnlNeg,
          bestPnl5Pos: best.pnl5Pos,
          bestPnl5Neg: best.pnl5Neg,
          side: best.legs[0].type,
        }, ...prev].slice(0, 200))
      }

      // Paper trading — runs with the exact same data
      if (autoTrade) {
        setPositions(prev => {
          const openIdx = prev.findIndex((p: PaperPosition) => p.status === 'open')

          if (openIdx >= 0) {
            const pos = prev[openIdx]
            let value = 0
            for (const leg of pos.legs) {
              const opt = chain.find((o: OptionRow) => o.strike === leg.strike && o.type === leg.type)
              if (opt) value += opt.bid * leg.quantity
            }
            const pnl = +(value - pos.cost).toFixed(2)
            const timeStr = data.pricePath[data.pricePath.length - 1]?.time || ''

            if (pnl >= tp || pnl <= -sl) {
              const updated = [...prev]
              updated[openIdx] = { ...pos, currentValue: +value.toFixed(2), pnl, status: pnl >= 0 ? 'tp' : 'sl', exitTime: timeStr, exitSpot: spot }
              return updated
            }

            const updated = [...prev]
            updated[openIdx] = { ...pos, currentValue: +value.toFixed(2), pnl }
            return updated
          }

          const best = findBestCombo(chain, spot, maxCost, templateMove, minPnl10, minPnl, minPnlHalf, minSideDelta, minBalance, minGap, minSpotGap, maxStep, 1)
          if (!best.length) return prev
          const timeStr = data.pricePath[data.pricePath.length - 1]?.time || ''
          return [...prev, {
            id: Date.now() + Math.random(),
            entryTime: timeStr,
            entrySpot: spot,
            legs: best[0].legs,
            cost: best[0].cost,
            currentValue: best[0].cost,
            pnl: 0,
            status: 'open',
          }]
        })
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load live data')
    }
    setLoading(false)
  }, [maxCost, templateMove, minPnl10, minPnl, minPnlHalf, minSideDelta, minBalance, minGap, minSpotGap, maxStep, autoTrade, tp, sl])

  useEffect(() => {
    fetchLive()
    const interval = setInterval(fetchLive, 30_000)
    return () => clearInterval(interval)
  }, [fetchLive])

  const openPos = positions.find(p => p.status === 'open')
  const closedPositions = positions.filter(p => p.status !== 'open')
  const totalPnl = closedPositions.reduce((s, p) => s + p.pnl, 0)
  const wins = closedPositions.filter(p => p.pnl > 0).length
  const losses = closedPositions.filter(p => p.pnl <= 0).length

  const refresh = async () => {
    setRefreshing(true)
    await fetchLive()
    setRefreshing(false)
  }

  const clearHistory = () => {
    setPositions([])
    setComboHistory([])
  }

  const atmCall = liveData?.openingChain?.filter(r => r.type === 'call' && Math.abs(r.strike - liveData.spot) < 10) || []
  const atmPut = liveData?.openingChain?.filter(r => r.type === 'put' && Math.abs(r.strike - liveData.spot) < 10) || []
  const atmStraddle = atmCall.length && atmPut.length
    ? (atmCall[0].ask + atmPut[0].ask) / 2
    : 0

  const callCombos = comboResults.filter(r => r.side === 'call')
  const putCombos = comboResults.filter(r => r.side === 'put')
  const callScore = callCombos.length ? Math.max(...callCombos.map(c => c.score)) : 0
  const putScore = putCombos.length ? Math.max(...putCombos.map(c => c.score)) : 0
  const bias = callScore > putScore ? 'Bullish' : putScore > callScore ? 'Bearish' : 'Neutral'

  return (
    <div className="space-y-6">
      {/* Market Overview */}
      <div className="bg-zgray/40 border border-zborder rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white">Live Market</h2>
          <div className="flex items-center gap-3">
            {liveData && (
              <span className="text-xs text-ztextdim">{liveData.date} {liveData.pricePath[0]?.time}</span>
            )}
            <button onClick={refresh} disabled={refreshing}
              className="px-3 py-1 text-xs font-medium text-zcyan border border-zcyan/40 rounded-lg hover:bg-zcyan/10 disabled:opacity-40">
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>
        {error && (
          <div className="bg-zred/10 border border-zred/30 rounded-lg p-3 mb-4 text-sm text-zred">{error}</div>
        )}
        {loading && !liveData && (
          <div className="text-ztextdim text-sm">Loading live data...</div>
        )}
        {liveData && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard label="SPX" value={liveData.spot.toFixed(2)} />
            <MetricCard label="ATM Straddle" value={atmStraddle.toFixed(2)} />
            <MetricCard label="Chain" value={`${liveData.openingChain.length} opts`} />
            <MetricCard label="Bias" value={bias} color={bias === 'Bullish' ? '#22c55e' : bias === 'Bearish' ? '#ef4444' : ''} />
          </div>
        )}
      </div>

      {/* Scan Parameters */}
      <div className="bg-zgray/40 border border-zborder rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Scan Parameters</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <ParamInput label="Max Cost" value={maxCost} onChange={setMaxCost} min={10} max={100} step={5} />
          <ParamInput label="Template Move" value={templateMove} onChange={setTemplateMove} min={5} max={20} step={1} />
          <ParamInput label="Min P&L 10" value={minPnl10} onChange={setMinPnl10} min={0.5} max={3} step={0.1} />
          <ParamInput label="Min P&L Weak" value={minPnl} onChange={setMinPnl} min={0} max={2} step={0.1} />
          <ParamInput label="Min P&L 1/2" value={minPnlHalf} onChange={setMinPnlHalf} min={0} max={1} step={0.1} />
          <ParamInput label="Min Side Δ" value={minSideDelta} onChange={setMinSideDelta} min={0.1} max={1} step={0.05} />
          <ParamInput label="Min Balance" value={minBalance} onChange={setMinBalance} min={0.5} max={1} step={0.05} />
          <ParamInput label="Min Gap" value={minGap} onChange={setMinGap} min={0} max={30} step={1} />
          <ParamInput label="Min Spot Gap" value={minSpotGap} onChange={setMinSpotGap} min={0} max={30} step={1} />
          <ParamInput label="Max Step" value={maxStep} onChange={setMaxStep} min={1} max={20} step={1} />
        </div>
        <div className="mt-2 text-xs text-ztextdim">
          {comboResults.length} combo{comboResults.length !== 1 ? 's' : ''} found
          {openPos && <span className="ml-3 text-zyellow">— trade active</span>}
        </div>
      </div>

      {/* Direction Analysis */}
      {comboResults.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-zgray/40 border border-zborder rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3" style={{ color: '#22c55e' }}>Call Combos (Bullish) — {callCombos.length}</h3>
            {callCombos.slice(0, 5).map((c, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 text-xs border-b border-zborder/40 last:border-0">
                <span className="font-mono text-white">{c.legs}</span>
                <span className="text-ztextdim">cost {c.cost.toFixed(1)}</span>
                <span className="text-zpurple">score {c.score.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="bg-zgray/40 border border-zborder rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3" style={{ color: '#ef4444' }}>Put Combos (Bearish) — {putCombos.length}</h3>
            {putCombos.slice(0, 5).map((c, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 text-xs border-b border-zborder/40 last:border-0">
                <span className="font-mono text-white">{c.legs}</span>
                <span className="text-ztextdim">cost {c.cost.toFixed(1)}</span>
                <span className="text-zpurple">score {c.score.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full Results Table */}
      {comboResults.length > 0 && (
        <div className="bg-zgray/40 border border-zborder rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-3">All Combos</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-ztextdim border-b border-zborder/40">
                  <th className="text-left py-2 pr-3">Legs</th>
                  <th className="text-right px-2">Side</th>
                  <th className="text-right px-2">Cost</th>
                  <th className="text-right px-2">Score</th>
                  <th className="text-right px-2">P&L +5</th>
                  <th className="text-right px-2">P&L −5</th>
                  <th className="text-right px-2">P&L +10</th>
                  <th className="text-right px-2">P&L −10</th>
                </tr>
              </thead>
              <tbody>
                {comboResults.map((c, i) => (
                  <tr key={i} className="border-b border-zborder/20 hover:bg-zgray/20">
                    <td className="py-2 pr-3 font-mono text-white">{c.legs}</td>
                    <td className={`text-right px-2 ${c.side === 'call' ? 'text-zgreen' : 'text-zred'}`}>{c.side}</td>
                    <td className="text-right px-2 font-mono text-ztextdim">{c.cost.toFixed(1)}</td>
                    <td className="text-right px-2 font-mono text-zpurple">{c.score.toFixed(2)}</td>
                    <td className={`text-right px-2 font-mono ${c.pnl5Pos >= 0 ? 'text-zgreen' : 'text-zred'}`}>{c.pnl5Pos.toFixed(2)}</td>
                    <td className={`text-right px-2 font-mono ${c.pnl5Neg >= 0 ? 'text-zgreen' : 'text-zred'}`}>{c.pnl5Neg.toFixed(2)}</td>
                    <td className={`text-right px-2 font-mono ${c.pnl10Pos >= 0 ? 'text-zgreen' : 'text-zred'}`}>{c.pnl10Pos.toFixed(2)}</td>
                    <td className={`text-right px-2 font-mono ${c.pnl10Neg >= 0 ? 'text-zgreen' : 'text-zred'}`}>{c.pnl10Neg.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Paper Trading */}
      <div className="bg-zgray/40 border border-zborder rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Paper Trading</h3>
          <div className="flex items-center gap-3">
            <button onClick={clearHistory}
              className="px-3 py-1 text-xs font-medium text-ztextdim border border-zborder/40 rounded-lg hover:text-zred hover:border-zred/40">
              Clear History
            </button>
            <button onClick={() => setAutoTrade(!autoTrade)}
              className={`px-4 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                autoTrade
                  ? 'bg-zgreen/20 text-zgreen border border-zgreen/50'
                  : 'bg-zgray/60 text-ztextdim border border-zborder/40 hover:border-zcyan/30'
              }`}>
              {autoTrade ? '● Auto Trading' : '○ Auto Trade Off'}
            </button>
          </div>
        </div>

        {/* TP/SL params + Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <ParamInput label="Take Profit (pts)" value={tp} onChange={setTp} min={0.1} max={5} step={0.1} />
          <ParamInput label="Stop Loss (pts)" value={sl} onChange={setSl} min={0.5} max={10} step={0.5} />
          <MetricCard label="Total P&L" value={totalPnl.toFixed(2)} color={totalPnl >= 0 ? '#22c55e' : '#ef4444'} />
          <MetricCard label="W/L" value={`${wins} / ${losses}`} />
        </div>

        {/* Current Position */}
        {openPos && (
          <div className="bg-zborder/10 border border-zyellow/30 rounded-lg p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-zyellow">● Open Position</span>
              <span className="text-xs text-ztextdim">{openPos.entryTime}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-2">
              <div><span className="text-ztextdim">Entry SPX</span> <span className="text-white font-mono ml-1">{openPos.entrySpot.toFixed(2)}</span></div>
              <div><span className="text-ztextdim">Cost</span> <span className="text-white font-mono ml-1">{openPos.cost.toFixed(2)}</span></div>
              <div><span className="text-ztextdim">Value</span> <span className="text-white font-mono ml-1">{openPos.currentValue.toFixed(2)}</span></div>
              <div>
                <span className="text-ztextdim">P&L</span>
                <span className={`font-mono ml-1 ${openPos.pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>
                  {openPos.pnl >= 0 ? '+' : ''}{openPos.pnl.toFixed(2)}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="text-ztextdim">Legs:</span>
              {openPos.legs.map((l, i) => (
                <span key={i} className="font-mono text-white bg-zgray/60 px-2 py-0.5 rounded">
                  {l.type[0].toUpperCase()}{l.strike} {l.quantity > 1 ? `x${l.quantity}` : ''}
                </span>
              ))}
            </div>
            {/* TP/SL bars */}
            <div className="mt-3 h-1.5 bg-zgray/60 rounded-full overflow-hidden">
              <div className="h-full bg-zgreen/40 rounded-full" style={{ width: `${Math.min(100, (openPos.pnl / tp) * 50 + 50)}%` }} />
            </div>
            <div className="flex justify-between text-[10px] text-ztextdim mt-0.5">
              <span>SL -{sl}</span>
              <span>TP +{tp}</span>
            </div>
          </div>
        )}

        {!openPos && autoTrade && (
          <div className="text-xs text-ztextdim mb-4">Scanning for trades on each data refresh...</div>
        )}
        {!openPos && !autoTrade && (
          <div className="text-xs text-ztextdim mb-4">Enable Auto Trade to paper-trade combos automatically.</div>
        )}

        {/* Trade History */}
        {closedPositions.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-ztextdim uppercase tracking-wide mb-2">Trade History</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-ztextdim border-b border-zborder/40">
                    <th className="text-left py-1.5 pr-2">Entry</th>
                    <th className="text-left py-1.5 pr-2">Exit</th>
                    <th className="text-right px-2">Legs</th>
                    <th className="text-right px-2">Cost</th>
                    <th className="text-right px-2">Result</th>
                    <th className="text-right px-2">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {[...closedPositions].reverse().slice(0, 20).map((p) => (
                    <tr key={p.id} className="border-b border-zborder/20 hover:bg-zgray/20">
                      <td className="py-1.5 pr-2 text-ztextdim">{p.entryTime}</td>
                      <td className="py-1.5 pr-2 text-ztextdim">{p.exitTime || '-'}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-white">{p.legs.map(l => `${l.type[0]}${l.strike}`).join('+')}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-ztextdim">{p.cost.toFixed(1)}</td>
                      <td className={`py-1.5 px-2 text-right font-bold ${p.status === 'tp' ? 'text-zgreen' : 'text-zred'}`}>{p.status.toUpperCase()}</td>
                      <td className={`py-1.5 px-2 text-right font-mono ${p.pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>{p.pnl >= 0 ? '+' : ''}{p.pnl.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Combo Scan History — all qualifying combos found */}
        {comboHistory.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-ztextdim uppercase tracking-wide mb-2">
              Combo Scan History ({comboHistory.length} scans)
            </h4>
            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-ztextdim border-b border-zborder/40 sticky top-0 bg-zgray">
                    <th className="text-left py-1.5 pr-2">Time</th>
                    <th className="text-right pr-2">SPX</th>
                    <th className="text-right px-2">#</th>
                    <th className="text-left px-2">Best Combo</th>
                    <th className="text-right px-2">Cost</th>
                    <th className="text-right px-2">Score</th>
                    <th className="text-right px-2">+10</th>
                    <th className="text-right px-2">−10</th>
                  </tr>
                </thead>
                <tbody>
                  {comboHistory.slice(0, 50).map((e, i) => (
                    <tr key={i} className="border-b border-zborder/20 hover:bg-zgray/20">
                      <td className="py-1 pr-2 text-ztextdim font-mono">{e.time}</td>
                      <td className="py-1 pr-2 text-right font-mono text-white">{e.spot.toFixed(1)}</td>
                      <td className="py-1 px-2 text-right text-ztextdim">{e.total}</td>
                      <td className="py-1 px-2 font-mono text-white truncate max-w-[200px]">{e.bestLegs}</td>
                      <td className="py-1 px-2 text-right font-mono text-ztextdim">{e.bestCost.toFixed(1)}</td>
                      <td className="py-1 px-2 text-right font-mono text-zpurple">{e.bestScore.toFixed(2)}</td>
                      <td className={`py-1 px-2 text-right font-mono ${e.bestPnl10Pos >= 0 ? 'text-zgreen' : 'text-zred'}`}>{e.bestPnl10Pos.toFixed(2)}</td>
                      <td className={`py-1 px-2 text-right font-mono ${e.bestPnl10Neg >= 0 ? 'text-zgreen' : 'text-zred'}`}>{e.bestPnl10Neg.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
