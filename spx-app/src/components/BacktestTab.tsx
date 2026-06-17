import { useState, useRef, useMemo, useCallback } from 'react'
import type { SessionData, ChainSnapshot } from '../types'
import { fetchSession } from '../api'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, ReferenceLine } from 'recharts'
import { surfacePrice } from '../utils/pricing'
import { findBestCombo, type ComboLeg } from '../utils/combos'
import { ParamInput, MetricCard } from './shared/UI'

interface BacktestTrade {
  id: string; date: string; entryTick: number; exitTick: number
  entryTime: string; exitTime: string
  legs: ComboLeg[]; entryCost: number; exitValue: number
  pnl: number; pnlPct: number; exitReason: string
  score: number
}

interface BacktestResult {
  trades: BacktestTrade[]
  equityCurve: { tick: number; pnl: number }[]
  metrics: {
    totalTrades: number; winRate: number; avgPnl: number; medPnl: number
    avgWin: number; avgLoss: number; maxDrawdown: number; profitFactor: number
    sharpe: number; totalPnl: number; avgBarsHeld: number
  }
}

interface Params {
  maxCost: number; scanInterval: number; tpPoints: number; slPoints: number
  templateMove: number; minPnl10: number; minPnl: number; minPnlHalf: number; minSideDelta: number; minBalance: number; minGap: number; minSpotGap: number; maxStep: number
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

async function runBacktest(dates: string[], params: Params, onProgress: (u: { pct: number; msg: string; cumPnl: number; trades: BacktestTrade[]; equityCurve: { tick: number; pnl: number }[] }) => void): Promise<BacktestResult> {
  const trades: BacktestTrade[] = []
  const equityCurve: { tick: number; pnl: number }[] = []
  let cumPnl = 0

  for (let di = 0; di < dates.length; di++) {
    onProgress({ pct: (di / dates.length) * 100, msg: `Loading ${dates[di]}...`, cumPnl, trades, equityCurve })
    let session: SessionData
    try { session = await fetchSession(dates[di]) } catch { continue }

    let snapshots: ChainSnapshot[] = []
    try {
      const res = await fetch(`/api/sessions/${dates[di]}/snapshots`)
      const data = await res.json()
      snapshots = data.snapshots || []
    } catch { snapshots = [] }

    const totalTicks = session.pricePath.length
    let openTrade: { trade: BacktestTrade; legs: ComboLeg[]; entryTick: number } | null = null
    let tradeTakenThisDay = false

    let nextScanMin = -1
    for (let tick = 0; tick < totalTicks; tick++) {
      const spot = session.pricePath[tick].price
      const tickTime = session.pricePath[tick].time
      const tickMin = timeToMinutes(tickTime)
      const chain = snapshots[tick]?.chain || session.openingChain

      if (!openTrade && !tradeTakenThisDay && tickMin >= nextScanMin) {
        const results = findBestCombo(chain, spot, params.maxCost, params.templateMove, params.minPnl10, params.minPnl, params.minPnlHalf, params.minSideDelta, params.minBalance, params.minGap, params.minSpotGap, params.maxStep)
        const pos = results[0]
        if (pos) {
          const trade: BacktestTrade = {
            id: `${dates[di]}_${tick}`,
            date: dates[di], entryTick: tick, exitTick: tick,
            entryTime: tickTime, exitTime: '',
            legs: pos.legs, entryCost: pos.cost, exitValue: 0,
            pnl: 0, pnlPct: 0, exitReason: '', score: pos.score,
          }
          openTrade = { trade, legs: pos.legs, entryTick: tick }
          tradeTakenThisDay = true
          nextScanMin = tickMin + params.scanInterval
        }
      }

      if (openTrade) {
        if (tick === openTrade.entryTick) continue
        const { trade, legs } = openTrade
        const currentVal = legs.reduce((s, l) => s + l.quantity * surfacePrice(chain, l.strike, l.type, 0, false), 0)
        const pnl = currentVal - trade.entryCost

        if (pnl >= params.tpPoints) {
          trade.exitTick = tick; trade.exitTime = session.pricePath[tick].time
          trade.exitValue = currentVal; trade.pnl = pnl; trade.pnlPct = (pnl / trade.entryCost) * 100
          trade.exitReason = 'TP'
          cumPnl += pnl
          trades.push(trade); openTrade = null
          equityCurve.push({ tick: equityCurve.length, pnl: cumPnl })
          onProgress({ pct: ((di + (tick / totalTicks)) / dates.length) * 100, msg: `${dates[di]} TP ${trade.legs.map(l => `${l.type[0]}${l.strike}`).join('+')} $${pnl.toFixed(2)}`, cumPnl, trades, equityCurve })
        } else if (pnl <= -params.slPoints) {
          trade.exitTick = tick; trade.exitTime = session.pricePath[tick].time
          trade.exitValue = currentVal; trade.pnl = pnl; trade.pnlPct = (pnl / trade.entryCost) * 100
          trade.exitReason = 'SL'
          cumPnl += pnl
          trades.push(trade); openTrade = null
          equityCurve.push({ tick: equityCurve.length, pnl: cumPnl })
          onProgress({ pct: ((di + (tick / totalTicks)) / dates.length) * 100, msg: `${dates[di]} SL ${trade.legs.map(l => `${l.type[0]}${l.strike}`).join('+')} $${pnl.toFixed(2)}`, cumPnl, trades, equityCurve })
        }
      }

      if (tick % 10 === 0 && tick > 0) {
        onProgress({ pct: ((di + (tick / totalTicks)) / dates.length) * 100, msg: `Processing ${dates[di]} (tick ${tick}/${totalTicks})`, cumPnl, trades, equityCurve })
      }
    }

    if (openTrade) {
      const { trade, legs } = openTrade
      const finalTick = totalTicks - 1
      const finalChain = snapshots[finalTick]?.chain || session.openingChain
      const finalVal = legs.reduce((s, l) => s + l.quantity * surfacePrice(finalChain, l.strike, l.type, 0, false), 0)
      trade.exitTick = finalTick; trade.exitTime = session.pricePath[finalTick].time
      trade.exitValue = finalVal; trade.pnl = finalVal - trade.entryCost
      trade.pnlPct = trade.entryCost > 0 ? (trade.pnl / trade.entryCost) * 100 : 0
      trade.exitReason = 'EOS'
      cumPnl += trade.pnl
      trades.push(trade); openTrade = null
      equityCurve.push({ tick: equityCurve.length, pnl: cumPnl })
    }

    onProgress({ pct: ((di + 1) / dates.length) * 100, msg: `Done ${dates[di]} (${di + 1}/${dates.length})${tradeTakenThisDay ? ` - ${trades[trades.length-1].exitReason} $${trades[trades.length-1].pnl.toFixed(2)}` : ' - no trade'}`, cumPnl, trades, equityCurve })
  }

  const pnls = trades.map(t => t.pnl)
  const wins = pnls.filter(p => p > 0)
  const losses = pnls.filter(p => p <= 0)
  const winRate = trades.length > 0 ? wins.length / trades.length : 0
  const avgPnl = trades.length > 0 ? pnls.reduce((s, p) => s + p, 0) / trades.length : 0
  const sorted = [...pnls].sort((a, b) => a - b)
  const medPnl = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0
  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p, 0) / losses.length : 0
  const maxDrawdown = computeMaxDrawdown(equityCurve.map(e => e.pnl))
  const profitFactor = losses.length > 0 && avgLoss !== 0 ? Math.abs((wins.length * avgWin) / (losses.length * avgLoss)) : 0
  const barsHeld = trades.map(t => t.exitTick - t.entryTick)
  const avgBarsHeld = barsHeld.length > 0 ? barsHeld.reduce((s, b) => s + b, 0) / barsHeld.length : 0

  const returns = equityCurve.map((e, i) => i === 0 ? 0 : (e.pnl - equityCurve[i - 1].pnl))
  const avgR = returns.reduce((s, r) => s + r, 0) / (returns.length || 1)
  const stdR = Math.sqrt(returns.reduce((s, r) => s + (r - avgR) ** 2, 0) / (returns.length || 1))
  const sharpe = stdR > 0 ? avgR / stdR : 0

  onProgress({ pct: 100, msg: `Complete — ${trades.length} trades`, cumPnl, trades, equityCurve })
  return { trades, equityCurve, metrics: { totalTrades: trades.length, winRate, avgPnl, medPnl, avgWin, avgLoss, maxDrawdown, profitFactor, sharpe, totalPnl: cumPnl, avgBarsHeld } }
}

function computeMaxDrawdown(equity: number[]): number {
  let peak = -Infinity, maxDD = 0
  for (const v of equity) {
    if (v > peak) peak = v
    const dd = peak > 0 ? (peak - v) / peak : 0
    if (dd > maxDD) maxDD = dd
  }
  return maxDD
}

export default function BacktestTab({ sessions }: { sessions: { date: string; id: string }[] }) {
  const [params, setParams] = useState<Params>({
    maxCost: 50, scanInterval: 5, tpPoints: 1, slPoints: 2, templateMove: 10, minPnl10: 1, minPnl: 0, minPnlHalf: 0.4, minSideDelta: 0.5, minBalance: 0.85, minGap: 15, minSpotGap: 10, maxStep: 10,
  })
  const [mode, setMode] = useState<'range' | 'pick'>('range')
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [liveEquity, setLiveEquity] = useState<{ tick: number; pnl: number }[]>([])
  const [liveTrades, setLiveTrades] = useState<BacktestTrade[]>([])
  const canceledRef = useRef(false)

  const updateParam = useCallback(<K extends keyof Params>(k: K, v: Params[K]) => {
    setParams(p => ({ ...p, [k]: v }))
  }, [])

  const allDates = useMemo(() => sessions.map(s => s.date), [sessions])

  const toggleDate = (d: string) => {
    setSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d); else next.add(d)
      return next
    })
  }

  const handleRun = async () => {
    setRunning(true); setProgress(0); setProgressMsg('Starting...')
    setLiveEquity([]); setLiveTrades([])
    canceledRef.current = false
    const dates = mode === 'range' ? allDates.slice(0, 50) : [...selectedDates].sort()
    if (dates.length === 0) { setRunning(false); return }

    const res = await runBacktest(dates, params, (u) => {
      if (!canceledRef.current) {
        setProgress(u.pct); setProgressMsg(u.msg)
        setLiveEquity([...u.equityCurve])
        setLiveTrades([...u.trades])
      }
    })
    if (!canceledRef.current) { setLiveEquity(res.equityCurve); setLiveTrades(res.trades) }
    setRunning(false)
  }

  return (
    <div className="space-y-4">
      <div className="panel-bg border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Backtest: ±10 Profit Combo</h3>

        <div className="flex gap-2 mb-4">
          <button onClick={() => setMode('range')} className={`px-3 py-1 text-xs rounded ${mode === 'range' ? 'bg-zcyan/20 text-zcyan border border-zcyan' : 'text-ztextdim border border-zborder'}`}>Range</button>
          <button onClick={() => setMode('pick')} className={`px-3 py-1 text-xs rounded ${mode === 'pick' ? 'bg-zcyan/20 text-zcyan border border-zcyan' : 'text-ztextdim border border-zborder'}`}>Pick Dates</button>
        </div>

        {mode === 'range' ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <ParamInput label="Max Cost (pts)" value={params.maxCost} onChange={v => updateParam('maxCost', v)} min={5} max={200} step={5} />
            <ParamInput label="Scan Every (min)" value={params.scanInterval} onChange={v => updateParam('scanInterval', v)} min={0.1} max={30} step={0.1} />
            <ParamInput label="TP (pts)" value={params.tpPoints} onChange={v => updateParam('tpPoints', v)} min={0.5} max={10} step={0.5} />
            <ParamInput label="SL (pts)" value={params.slPoints} onChange={v => updateParam('slPoints', v)} min={0.5} max={10} step={0.5} />
            <ParamInput label="Template (pts)" value={params.templateMove} onChange={v => updateParam('templateMove', v)} min={5} max={20} step={2.5} />
              <ParamInput label="Min P&L 10 (pts)" value={params.minPnl10} onChange={v => updateParam('minPnl10', v)} min={0} max={5} step={0.1} />
            <ParamInput label="Min P&L (pts)" value={params.minPnl} onChange={v => updateParam('minPnl', v)} min={0} max={5} step={0.1} />
            <ParamInput label="Min P&L 1/2 (pts)" value={params.minPnlHalf} onChange={v => updateParam('minPnlHalf', v)} min={0} max={5} step={0.1} />
            <ParamInput label="Min Side Delta" value={params.minSideDelta} onChange={v => updateParam('minSideDelta', v)} min={0} max={1} step={0.05} />
            <ParamInput label="Min Balance" value={params.minBalance} onChange={v => updateParam('minBalance', v)} min={0} max={1} step={0.05} />
            <ParamInput label="Min Gap" value={params.minGap} onChange={v => updateParam('minGap', v)} min={0} max={50} step={5} />
            <ParamInput label="Max Step" value={params.maxStep} onChange={v => updateParam('maxStep', v)} min={1} max={50} step={1} />
            <div className="flex items-center gap-2">
              <label className="text-xs text-ztextdim">Dates:</label>
              <span className="text-xs font-mono text-ztext">{allDates.length} available (all 0DTE)</span>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <ParamInput label="Max Cost (pts)" value={params.maxCost} onChange={v => updateParam('maxCost', v)} min={5} max={200} step={5} />
              <ParamInput label="Scan Every (min)" value={params.scanInterval} onChange={v => updateParam('scanInterval', v)} min={0.1} max={30} step={0.1} />
              <ParamInput label="TP (pts)" value={params.tpPoints} onChange={v => updateParam('tpPoints', v)} min={0.5} max={10} step={0.5} />
              <ParamInput label="SL (pts)" value={params.slPoints} onChange={v => updateParam('slPoints', v)} min={0.5} max={10} step={0.5} />
            </div>
            <div className="flex flex-wrap gap-3 mt-2">
              <ParamInput label="Template (pts)" value={params.templateMove} onChange={v => updateParam('templateMove', v)} min={5} max={20} step={2.5} />
            <ParamInput label="Min P&L 10 (pts)" value={params.minPnl10} onChange={v => updateParam('minPnl10', v)} min={0} max={5} step={0.1} />
            <ParamInput label="Min P&L (pts)" value={params.minPnl} onChange={v => updateParam('minPnl', v)} min={0} max={5} step={0.1} />
            <ParamInput label="Min P&L 1/2 (pts)" value={params.minPnlHalf} onChange={v => updateParam('minPnlHalf', v)} min={0} max={5} step={0.1} />
            <ParamInput label="Min Side Delta" value={params.minSideDelta} onChange={v => updateParam('minSideDelta', v)} min={0} max={1} step={0.05} />
            <ParamInput label="Min Balance" value={params.minBalance} onChange={v => updateParam('minBalance', v)} min={0} max={1} step={0.05} />
            <ParamInput label="Min Gap" value={params.minGap} onChange={v => updateParam('minGap', v)} min={0} max={50} step={5} />
            <ParamInput label="Max Step" value={params.maxStep} onChange={v => updateParam('maxStep', v)} min={1} max={50} step={1} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2 items-center">
              <span className="text-xs text-ztextdim">Select dates ({selectedDates.size} of {sessions.length}):</span>
              <button onClick={() => setSelectedDates(new Set(sessions.map(s => s.date)))} className="text-xs px-2 py-0.5 rounded bg-zgray border border-zborder text-ztextdim hover:text-ztext">All</button>
              <button onClick={() => setSelectedDates(new Set(sessions.slice(-30).map(s => s.date)))} className="text-xs px-2 py-0.5 rounded bg-zgray border border-zborder text-ztextdim hover:text-ztext">Last 30</button>
              <button onClick={() => setSelectedDates(new Set(sessions.slice(-10).map(s => s.date)))} className="text-xs px-2 py-0.5 rounded bg-zgray border border-zborder text-ztextdim hover:text-ztext">Last 10</button>
              <button onClick={() => setSelectedDates(new Set())} className="text-xs px-2 py-0.5 rounded bg-zgray border border-zborder text-ztextdim hover:text-ztext">None</button>
            </div>
            <div className="mt-2 max-h-40 overflow-y-auto border border-zborder rounded">
              {sessions.map(s => (
                <label key={s.date} className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-zgray/20 cursor-pointer">
                  <input type="checkbox" checked={selectedDates.has(s.date)} onChange={() => toggleDate(s.date)} className="accent-zcyan" />
                  {s.date}
                </label>
              ))}
            </div>
          </>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button onClick={handleRun} disabled={running} className="px-4 py-1.5 text-sm font-medium rounded bg-zcyan/20 text-zcyan border border-zcyan hover:bg-zcyan/30 disabled:opacity-50">
            {running ? 'Running...' : 'Run Backtest'}
          </button>
          {running && (
            <button onClick={() => { canceledRef.current = true; setRunning(false) }} className="px-3 py-1.5 text-xs text-zred border border-zred rounded">Cancel</button>
          )}
        </div>
        {running && (
          <div className="mt-3">
            <div className="flex justify-between text-xs text-ztextdim mb-1">
              <span>{progressMsg}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 bg-zborder rounded-full overflow-hidden">
              <div className="h-full bg-zcyan rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
      </div>

      {liveTrades.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <MetricCard label="Total Trades" value={liveTrades.length} />
            <MetricCard label="Win Rate" value={`${(liveTrades.filter(t => t.pnl > 0).length / Math.max(liveTrades.length, 1) * 100).toFixed(1)}%`} color={liveTrades.filter(t => t.pnl > 0).length / Math.max(liveTrades.length, 1) > 0.5 ? 'text-zgreen' : 'text-zred'} />
            <MetricCard label="Total P&L" value={`${liveEquity.length > 0 ? liveEquity[liveEquity.length - 1].pnl.toFixed(2) : '0.00'} pts`} color={liveEquity.length > 0 && liveEquity[liveEquity.length - 1].pnl >= 0 ? 'text-zgreen' : 'text-zred'} />
            <MetricCard label="Avg P&L" value={`${(liveTrades.reduce((s, t) => s + t.pnl, 0) / Math.max(liveTrades.length, 1)).toFixed(2)} pts`} />
            <MetricCard label="Max DD" value={`${running ? '...' : '0.0%'}`} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="panel-bg border border-zborder rounded-lg p-4">
              <h3 className="text-sm font-medium text-ztextdim mb-3">Equity Curve {running && <span className="text-zcyan animate-pulse">●</span>}</h3>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={liveEquity}>
                  <defs><linearGradient id="eqGrad2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#06b6d4" stopOpacity={0.3} /><stop offset="100%" stopColor="#06b6d4" stopOpacity={0} /></linearGradient></defs>
                  <XAxis dataKey="tick" tick={{ fontSize: 10, fill: '#6b7280' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
                  <ReferenceLine y={0} stroke="#2a2a4a" />
                  <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 6, fontSize: 11 }} formatter={(v) => [`${Number(v).toFixed(2)}`, 'P&L']} />
                  <Area type="monotone" dataKey="pnl" stroke="#06b6d4" fill="url(#eqGrad2)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="panel-bg border border-zborder rounded-lg p-4">
              <h3 className="text-sm font-medium text-ztextdim mb-3">P&L Distribution</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={(() => {
                  const pnls = liveTrades.map(t => t.pnl)
                  const maxP = Math.max(...pnls.map(p => Math.abs(p)), 0.01)
                  const bins = 10; const width = (maxP * 2) / bins
                  const counts = Array(bins).fill(0)
                  for (const p of pnls) { const idx = Math.min(Math.floor((p + maxP) / (maxP * 2 / bins)), bins - 1); counts[Math.max(0, idx)]++ }
                  return counts.map((c, i) => ({ bin: `${(-maxP + i * width).toFixed(1)}`, count: c }))
                })()}>
                  <XAxis dataKey="bin" tick={{ fontSize: 9, fill: '#6b7280' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
                  <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 6, fontSize: 11 }} />
                  <Bar dataKey="count" fill="#a855f7" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel-bg border border-zborder rounded-lg overflow-hidden">
            <div className="px-4 py-2 text-xs font-semibold text-ztextdim border-b border-zborder flex items-center justify-between">
              <span>Trades ({liveTrades.length})</span>
              {running && <span className="text-zcyan animate-pulse text-[10px]">● Live</span>}
            </div>
            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zdark/95 backdrop-blur-sm">
                  <tr className="text-ztextdim border-b border-zborder">
                    <th className="text-left px-2 py-1">Date</th>
                    <th className="text-left px-2 py-1">Legs</th>
                    <th className="text-right px-2 py-1">Entry</th>
                    <th className="text-right px-2 py-1">Exit</th>
                    <th className="text-right px-2 py-1">P&L</th>
                    <th className="text-right px-2 py-1">P&L%</th>
                    <th className="text-center px-2 py-1">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {liveTrades.slice(-100).map(t => (
                    <tr key={t.id} className="border-b border-zborder/50">
                      <td className="px-2 py-1 font-mono">{t.date.slice(5)}</td>
                      <td className="px-2 py-1 font-mono text-xs">
                        <span className="text-zgreen">{t.legs.filter(l => l.type === 'call').map(l => `${l.strike.toFixed(0)}x${l.quantity}`).join('+')}</span>
                        {' '}
                        <span className="text-zred">{t.legs.filter(l => l.type === 'put').map(l => `${l.strike.toFixed(0)}x${l.quantity}`).join('+')}</span>
                      </td>
                      <td className="text-right px-2 py-1 font-mono">{t.entryCost.toFixed(2)}</td>
                      <td className="text-right px-2 py-1 font-mono">{t.exitValue.toFixed(2)}</td>
                      <td className={`text-right px-2 py-1 font-mono ${t.pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>{t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}</td>
                      <td className={`text-right px-2 py-1 font-mono ${t.pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>{t.pnlPct > 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%</td>
                      <td className={`text-center px-2 py-1 ${t.exitReason === 'TP' ? 'text-zgreen' : t.exitReason === 'SL' ? 'text-zred' : 'text-ztextdim'}`}>{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

