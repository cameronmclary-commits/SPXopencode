import { useState, useRef, useCallback } from 'react'
import type { SessionData, OptionRow } from '../types'
import { fetchSession } from '../api'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, ReferenceLine } from 'recharts'

interface Leg {
  strike: number; type: 'call' | 'put'; quantity: number
  delta: number; gamma: number; entryMid: number
}

interface BacktestTrade {
  id: string; date: string; entryTick: number; exitTick: number
  entryTime: string; exitTime: string
  legs: Leg[]; entryCost: number; exitValue: number
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
  otmCount: number; maxCost: number; minScore: number; maxDelta: number
  scanInterval: number; tpDollars: number; slDollars: number
  yearStart: number; yearEnd: number
}

const R = 0.05, T = 1 / 365

function cdf(x: number): number {
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429], p = 0.3275911
  const s = x < 0 ? -1 : 1; const ax = Math.abs(x)
  const t = 1 / (1 + p * ax)
  let y = 1
  for (let i = 4; i >= 0; i--) y = 1 - (a[i] * t + (i > 0 ? y : 0)) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + s * y)
}

function normPdf(x: number) { return Math.exp(-0.5 * x * x) / Math.SQRT2 / Math.sqrt(Math.PI) }
function d1(S: number, K: number, T: number, r: number, sigma: number) { return (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T)) }
function bsPrice(S: number, K: number, T: number, r: number, sigma: number, isCall: boolean): number {
  if (T <= 0) return Math.max(0, isCall ? S - K : K - S)
  const d = d1(S, K, T, r, sigma); const d2 = d - sigma * Math.sqrt(T)
  return isCall ? S * cdf(d) - K * Math.exp(-r * T) * cdf(d2) : K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d)
}
function bsDelta(S: number, K: number, T: number, r: number, sigma: number, isCall: boolean): number {
  if (T <= 0) return isCall ? (S > K ? 1 : 0) : (S < K ? -1 : 0)
  return isCall ? cdf(d1(S, K, T, r, sigma)) : cdf(d1(S, K, T, r, sigma)) - 1
}
function bsGamma(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return 0
  const d = d1(S, K, T, r, sigma); return normPdf(d) / (S * sigma * Math.sqrt(T))
}

function backoutIV(S: number, K: number, T: number, r: number, mid: number, isCall: boolean): number {
  if (mid <= 0.01) return 0.3
  if (mid <= Math.max(0, isCall ? S - K : K - S) + 0.01) return 0.3
  let lo = 0.01, hi = 2.0
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (bsPrice(S, K, T, r, m, isCall) > mid) hi = m; else lo = m }
  return (lo + hi) / 2
}

function surfacePrice(chain: OptionRow[], strike: number, type: 'call' | 'put', priceShift: number): number {
  const shifted = type === 'call' ? strike - priceShift : strike + priceShift
  const same = chain.filter(r => r.type === type).sort((a, b) => a.strike - b.strike)
  if (same.length === 0) return 0
  if (shifted <= same[0].strike || shifted >= same[same.length - 1].strike) return 0
  let lo = 0, hi = same.length - 1
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (same[m].strike < shifted) lo = m; else hi = m }
  const t = (shifted - same[lo].strike) / (same[hi].strike - same[lo].strike)
  return same[lo].mid + t * (same[hi].mid - same[lo].mid)
}

function generateOnce(allCalls: EnhRow[], allPuts: EnhRow[], spot: number, otmCount: number, maxCost: number, minScore: number): { legs: Leg[]; cost: number; score: number } | null {
  let best: { legs: Leg[]; cost: number; score: number } | null = null
  const itmCalls = allCalls.filter(r => r.strike < spot && r.delta > 0.5)
  const itmPuts = allPuts.filter(r => r.strike > spot && r.delta < -0.5)
  const candidates: { legs: Leg[]; cost: number; score: number }[] = []

  for (const itm of itmCalls) {
    const between = allPuts.filter(r => r.strike > itm.strike && r.strike < spot).sort((a, b) => b.strike - a.strike)
    if (between.length < otmCount) continue
    for (const otms of getConsecutiveGroups(between, otmCount)) {
      const r = computePosition(itm, otms)
      if (r) candidates.push(r)
    }
  }

  for (const itm of itmPuts) {
    const between = allCalls.filter(r => r.strike > spot && r.strike < itm.strike).sort((a, b) => a.strike - b.strike)
    if (between.length < otmCount) continue
    for (const otms of getConsecutiveGroups(between, otmCount)) {
      const r = computePosition(itm, otms)
      if (r) candidates.push(r)
    }
  }

  for (const c of candidates) {
    if (c.cost > maxCost) continue
    if (c.score < minScore) continue
    if (!best || c.score > best.score) best = c
  }
  return best
}

function computePosition(itmRow: EnhRow, otmRows: EnhRow[]): { legs: Leg[]; cost: number; score: number } | null {
  let best: { legs: Leg[]; cost: number; score: number } | null = null
  let bestScore = -Infinity
  const n = otmRows.length

  const search = (idx: number, chosen: number[]) => {
    if (idx === n) {
      let delta = itmRow.delta; let gamma = itmRow.gamma; let cost = itmRow.mid
      const legs: Leg[] = [{ strike: itmRow.strike, type: itmRow.type, quantity: 1, delta: itmRow.delta, gamma: itmRow.gamma, entryMid: itmRow.mid }]
      for (let i = 0; i < n; i++) {
        const q = chosen[i]; const r = otmRows[i]
        delta += q * r.delta; gamma += q * r.gamma; cost += q * r.mid
        legs.push({ strike: r.strike, type: r.type, quantity: q, delta: r.delta, gamma: r.gamma, entryMid: r.mid })
      }
      if (gamma <= 0 || Math.abs(delta) > 0.5) return
      const sc = gamma / (cost + 0.01) * 100 - Math.abs(delta) * 3
      if (sc > bestScore || !best) { bestScore = sc; best = { legs, cost, score: sc } }
      return
    }
    for (let q = 1; q <= (idx === 0 ? 2 : 3); q++) { chosen.push(q); search(idx + 1, chosen); chosen.pop() }
  }
  search(0, [])
  return best
}

interface EnhRow extends OptionRow { delta: number; gamma: number; iv: number }
function enhance(r: OptionRow, spot: number): EnhRow {
  const iv = backoutIV(spot, r.strike, T, R, r.mid, r.type === 'call')
  return { ...r, iv, delta: bsDelta(spot, r.strike, T, R, iv, r.type === 'call'), gamma: bsGamma(spot, r.strike, T, R, iv) }
}

function getConsecutiveGroups<T extends { strike: number }>(arr: T[], k: number): T[][] {
  if (arr.length < k) return []
  const sorted = [...arr].sort((a, b) => a.strike - b.strike)
  const r: T[][] = []
  for (let i = 0; i <= sorted.length - k; i++) {
    const g = sorted.slice(i, i + k)
    const ok = g.every((_, j) => j === 0 || Math.abs(g[j].strike - g[j - 1].strike) === 5 || Math.abs(g[j].strike - g[j - 1].strike) === 0)
    if (ok) r.push(g)
  }
  return r
}

function repriceChain(chain: OptionRow[], spot: number, elapsed: number, total: number, iv: number): OptionRow[] {
  const tt = Math.max(0.001, (1 - elapsed / total) / 365)
  return chain.map(o => {
    if (o.strike <= 0) return o
    const sigma = iv * (1 + 0.2 * Math.abs(o.strike - spot) / spot)
    const mp = bsPrice(spot, o.strike, tt, R, sigma, o.type === 'call')
    const f = (o.mid || 0.01) > 0 ? mp / (o.mid || 0.01) : 1
    return { ...o, bid: Math.max(0, o.mid * f * 0.9), ask: o.mid * f * 1.1, mid: mp, last: mp }
  })
}

async function runBacktest(dates: string[], params: Params, onProgress: (pct: number, msg: string) => void): Promise<BacktestResult> {
  const trades: BacktestTrade[] = []
  const equityCurve: { tick: number; pnl: number }[] = []
  let cumPnl = 0

  for (let di = 0; di < dates.length; di++) {
    onProgress((di / dates.length) * 100, `Loading ${dates[di]}...`)
    let session: SessionData
    try { session = await fetchSession(dates[di]) } catch { continue }

    const totalTicks = session.pricePath.length
    const iv = 0.2
    let openTrade: { trade: BacktestTrade; legs: Leg[] } | null = null
    let sessionPnl = 0

    let entered = false
    for (let tick = 0; tick < totalTicks; tick += params.scanInterval) {
      const spot = session.pricePath[tick].price
      const repriced = repriceChain(session.openingChain, spot, tick, totalTicks, iv)
      const range = spot * 0.007
      const calls = repriced.filter(r => r.type === 'call' && r.strike > spot - range && r.strike < spot + range).map(r => enhance(r, spot)).filter(r => Math.abs(r.delta) > 0.05 && Math.abs(r.delta) < 0.95)
      const puts = repriced.filter(r => r.type === 'put' && r.strike < spot + range && r.strike > spot - range).map(r => enhance(r, spot)).filter(r => Math.abs(r.delta) > 0.05 && Math.abs(r.delta) < 0.95)

      if (!openTrade && !entered) {
        const pos = generateOnce(calls, puts, spot, params.otmCount, params.maxCost, params.minScore)
        if (pos) {
          entered = true
          const trade: BacktestTrade = {
            id: `${dates[di]}_${tick}`,
            date: dates[di], entryTick: tick, exitTick: tick,
            entryTime: session.pricePath[tick].time, exitTime: '',
            legs: pos.legs, entryCost: pos.cost, exitValue: 0,
            pnl: 0, pnlPct: 0, exitReason: '', score: pos.score,
          }
          openTrade = { trade, legs: pos.legs }
        }
      }

      if (openTrade) {
        const { trade, legs } = openTrade
        const baseSpot = session.pricePath[0].price
        const currentVal = legs.reduce((s, l) => s + l.quantity * surfacePrice(session.openingChain, l.strike, l.type, spot - baseSpot), 0)
        const pnl = currentVal - trade.entryCost

        if (pnl >= params.tpDollars) {
          trade.exitTick = tick; trade.exitTime = session.pricePath[tick].time
          trade.exitValue = currentVal; trade.pnl = pnl; trade.pnlPct = (pnl / trade.entryCost) * 100
          trade.exitReason = 'TP'
          cumPnl += pnl; sessionPnl += pnl
          trades.push(trade); openTrade = null
          equityCurve.push({ tick: equityCurve.length, pnl: cumPnl })
        } else if (pnl <= -params.slDollars) {
          trade.exitTick = tick; trade.exitTime = session.pricePath[tick].time
          trade.exitValue = currentVal; trade.pnl = pnl; trade.pnlPct = (pnl / trade.entryCost) * 100
          trade.exitReason = 'SL'
          cumPnl += pnl; sessionPnl += pnl
          trades.push(trade); openTrade = null
          equityCurve.push({ tick: equityCurve.length, pnl: cumPnl })
        }
      }
    }

    if (openTrade) {
      const { trade, legs } = openTrade
      const finalSpot = session.pricePath[totalTicks - 1].price
      const baseSpot = session.pricePath[0].price
      const finalVal = legs.reduce((s, l) => s + l.quantity * surfacePrice(session.openingChain, l.strike, l.type, finalSpot - baseSpot), 0)
      trade.exitTick = totalTicks - 1; trade.exitTime = session.pricePath[totalTicks - 1].time
      trade.exitValue = finalVal; trade.pnl = finalVal - trade.entryCost
      trade.pnlPct = trade.entryCost > 0 ? (trade.pnl / trade.entryCost) * 100 : 0
      trade.exitReason = 'EOS'
      cumPnl += trade.pnl; sessionPnl += trade.pnl
      trades.push(trade); openTrade = null
      equityCurve.push({ tick: equityCurve.length, pnl: cumPnl })
    }

    if (di % 10 === 0) onProgress(((di + 1) / dates.length) * 100, `Processed ${dates[di]} (${di + 1}/${dates.length})`)
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
  const sharpe = stdR > 0 ? avgR / stdR * Math.sqrt(252) : 0

  onProgress(100, `Complete — ${trades.length} trades`)
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

export default function BacktestTab({ sessions }: { sessions: { date: string }[] }) {
  const [params, setParams] = useState<Params>({
    otmCount: 2, maxCost: 50, minScore: 5, maxDelta: 0.3,
    scanInterval: 5, tpDollars: 1, slDollars: 2,
    yearStart: 2024, yearEnd: 2025,
  })
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [result, setResult] = useState<BacktestResult | null>(null)
  const canceledRef = useRef(false)

  const updateParam = useCallback(<K extends keyof Params>(k: K, v: Params[K]) => {
    setParams(p => ({ ...p, [k]: v }))
  }, [])

  const handleRun = async () => {
    setRunning(true); setProgress(0); setProgressMsg('Starting...'); setResult(null)
    canceledRef.current = false
    const dates = sessions.map(s => s.date).filter(d => {
      const y = parseInt(d.slice(0, 4))
      return y >= params.yearStart && y <= params.yearEnd
    }).slice(0, 50)

    const res = await runBacktest(dates, params, (pct, msg) => {
      if (!canceledRef.current) { setProgress(pct); setProgressMsg(msg) }
    })
    if (!canceledRef.current) setResult(res)
    setRunning(false)
  }

  return (
    <div className="space-y-4">
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Backtest: Delta-Neutral Strategy</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <ParamInput label="OTM legs" value={params.otmCount} onChange={v => updateParam('otmCount', v)} min={2} max={3} />
          <ParamInput label="Max Cost ($)" value={params.maxCost} onChange={v => updateParam('maxCost', v)} min={5} max={200} step={5} />
          <ParamInput label="Min Score" value={params.minScore} onChange={v => updateParam('minScore', v)} min={0} max={50} step={1} />
          <ParamInput label="Max |Delta|" value={params.maxDelta} onChange={v => updateParam('maxDelta', v)} min={0.05} max={0.5} step={0.05} />
          <ParamInput label="Scan Interval (ticks)" value={params.scanInterval} onChange={v => updateParam('scanInterval', v)} min={1} max={20} step={1} />
          <ParamInput label="Take Profit ($)" value={params.tpDollars} onChange={v => updateParam('tpDollars', v)} min={0.5} max={10} step={0.5} />
          <ParamInput label="Stop Loss ($)" value={params.slDollars} onChange={v => updateParam('slDollars', v)} min={0.5} max={10} step={0.5} />
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Year:</label>
            <select value={params.yearStart} onChange={e => { updateParam('yearStart', Number(e.target.value)); updateParam('yearEnd', Number(e.target.value) + 1) }} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext">
              <option value={2024}>2024</option>
              <option value={2025}>2025</option>
            </select>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={handleRun} disabled={running} className="px-4 py-1.5 text-sm font-medium rounded bg-zcyan/20 text-zcyan border border-zcyan hover:bg-zcyan/30 disabled:opacity-50">
            {running ? 'Running...' : 'Run Backtest'}
          </button>
          {running && (
            <button onClick={() => { canceledRef.current = true; setRunning(false) }} className="px-3 py-1.5 text-xs text-zred border border-zred rounded">
              Cancel
            </button>
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

      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <MetricCard label="Total Trades" value={result.metrics.totalTrades} />
            <MetricCard label="Win Rate" value={`${(result.metrics.winRate * 100).toFixed(1)}%`} color={result.metrics.winRate > 0.5 ? 'text-zgreen' : 'text-zred'} />
            <MetricCard label="Total P&L" value={`$${result.metrics.totalPnl.toFixed(2)}`} color={result.metrics.totalPnl >= 0 ? 'text-zgreen' : 'text-zred'} />
            <MetricCard label="Avg P&L" value={`$${result.metrics.avgPnl.toFixed(2)}`} color={result.metrics.avgPnl >= 0 ? 'text-zgreen' : 'text-zred'} />
            <MetricCard label="Max DD" value={`${(result.metrics.maxDrawdown * 100).toFixed(1)}%`} color="text-zred" />
            <MetricCard label="Profit Factor" value={result.metrics.profitFactor.toFixed(2)} />
            <MetricCard label="Sharpe" value={result.metrics.sharpe.toFixed(2)} color={result.metrics.sharpe > 1 ? 'text-zgreen' : result.metrics.sharpe > 0 ? 'text-zyellow' : 'text-zred'} />
            <MetricCard label="Avg Win" value={`$${result.metrics.avgWin.toFixed(2)}`} color="text-zgreen" />
            <MetricCard label="Avg Loss" value={`$${result.metrics.avgLoss.toFixed(2)}`} color="text-zred" />
            <MetricCard label="Avg Bars Held" value={result.metrics.avgBarsHeld.toFixed(1)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
              <h3 className="text-sm font-medium text-ztextdim mb-3">Equity Curve</h3>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={result.equityCurve}>
                  <defs><linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#06b6d4" stopOpacity={0.3} /><stop offset="100%" stopColor="#06b6d4" stopOpacity={0} /></linearGradient></defs>
                  <XAxis dataKey="tick" tick={{ fontSize: 10, fill: '#6b7280' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
                  <ReferenceLine y={0} stroke="#2a2a4a" />
                  <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 6, fontSize: 11 }} formatter={(v) => [`$${Number(v).toFixed(2)}`, 'P&L']} />
                  <Area type="monotone" dataKey="pnl" stroke="#06b6d4" fill="url(#eqGrad)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
              <h3 className="text-sm font-medium text-ztextdim mb-3">P&L Distribution</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={(() => {
                  const pnls = result.trades.map(t => t.pnl)
                  const maxP = Math.max(...pnls.map(p => Math.abs(p)))
                  const bins = 10; const width = (maxP * 2) / bins
                  const counts = Array(bins).fill(0)
                  for (const p of pnls) { const idx = Math.min(Math.floor((p + maxP) / (maxP * 2 / bins)), bins - 1); counts[idx]++ }
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

          <div className="bg-zgray/30 border border-zborder rounded-lg overflow-hidden">
            <div className="px-4 py-2 text-xs font-semibold text-ztextdim border-b border-zborder">
              Trades ({result.trades.length})
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
                  {result.trades.slice(-100).map(t => (
                    <tr key={t.id} className="border-b border-zborder/50">
                      <td className="px-2 py-1 font-mono">{t.date.slice(5)}</td>
                      <td className="px-2 py-1 font-mono text-xs">
                        <span className="text-zgreen">{t.legs.filter(l => l.type === 'call').map(l => `${l.strike.toFixed(0)}x${l.quantity}`).join('+')}</span>
                        {' '}
                        <span className="text-zred">{t.legs.filter(l => l.type === 'put').map(l => `${l.strike.toFixed(0)}x${l.quantity}`).join('+')}</span>
                      </td>
                      <td className="text-right px-2 py-1 font-mono">${t.entryCost.toFixed(2)}</td>
                      <td className="text-right px-2 py-1 font-mono">${t.exitValue.toFixed(2)}</td>
                      <td className={`text-right px-2 py-1 font-mono ${t.pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>
                        ${t.pnl.toFixed(2)}
                      </td>
                      <td className={`text-right px-2 py-1 font-mono ${t.pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>
                        {t.pnlPct > 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%
                      </td>
                      <td className={`text-center px-2 py-1 ${t.exitReason === 'TP' ? 'text-zgreen' : t.exitReason === 'SL' ? 'text-zred' : 'text-ztextdim'}`}>
                        {t.exitReason}
                      </td>
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

function ParamInput({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return (
    <div>
      <label className="text-xs text-ztextdim">{label}</label>
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value))} min={min} max={max} step={step || 1} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" />
    </div>
  )
}

function MetricCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-zgray/30 border border-zborder rounded-lg p-3">
      <div className="text-xs text-ztextdim mb-0.5">{label}</div>
      <div className={`text-sm font-semibold font-mono ${color || 'text-white'}`}>{value}</div>
    </div>
  )
}
