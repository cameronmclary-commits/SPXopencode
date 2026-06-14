import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { SessionData, OptionRow } from '../types'
import { fetchSession } from '../api'
import { XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart, Line } from 'recharts'

interface Props {
  selectedDate: string
}

function bsPrice(S: number, K: number, T: number, r: number, sigma: number, isCall: boolean): number {
  if (T <= 0) return Math.max(0, isCall ? S - K : K - S)
  if (sigma <= 0) return Math.max(0, isCall ? S - K : K - S)
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T))
  const d2 = d1 - sigma * Math.sqrt(T)
  const cdf = (x: number) => 0.5 * (1 + (x / Math.SQRT2) * 0.5) // simplified normal CDF
  if (isCall) return S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2)
  return K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1)
}

function priceChain(spot: number, chain: OptionRow[], timeElapsed: number, totalDuration: number, iv: number): OptionRow[] {
  const T = Math.max(0.001, (1 - timeElapsed / totalDuration) / 365)
  const r = 0.05
  return chain.map(o => {
    if (o.strike <= 0) return o
    const sigma = iv * (1 + 0.2 * Math.abs(o.strike - spot) / spot)
    const modelPrice = bsPrice(spot, o.strike, T, r, sigma, o.type === 'call')
    const originalMid = o.mid || 0.01
    const factor = originalMid > 0 ? modelPrice / originalMid : 1
    return {
      ...o,
      bid: Math.max(0, originalMid * factor * 0.9),
      ask: originalMid * factor * 1.1,
      mid: modelPrice,
      last: modelPrice,
    }
  })
}

export default function TradeLab({ selectedDate }: Props) {
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [tick, setTick] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [iv, setIv] = useState(0.2)
  const [paperTrades, setPaperTrades] = useState<{
    id: string; strike: number; type: 'call' | 'put'; action: 'buy' | 'sell';
    entryPrice: number; entryTick: number; quantity: number; status: 'open' | 'closed';
    exitPrice?: number; exitTick?: number; pnl?: number
  }[]>([])
  const [autoPilot, setAutoPilot] = useState(false)
  const [tpPct, setTpPct] = useState(50)
  const [slPct, setSlPct] = useState(25)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!selectedDate) return
    setLoading(true)
    setTick(0)
    setPlaying(false)
    setAutoPilot(false)
    fetchSession(selectedDate)
      .then(d => setSessionData(d))
      .catch(() => setSessionData(null))
      .finally(() => setLoading(false))
  }, [selectedDate])

  useEffect(() => {
    if (playing && sessionData) {
      timerRef.current = setInterval(() => {
        setTick(t => {
          const next = t + 1 * speed
          if (next >= sessionData.pricePath.length - 1) {
            setPlaying(false)
            return sessionData.pricePath.length - 1
          }
          return next
        })
      }, 100)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [playing, sessionData, speed])

  const currentPrice = sessionData?.pricePath[tick]?.price || sessionData?.spotPrice || 0
  const repricedChain = useMemo(() => {
    if (!sessionData) return []
    return priceChain(currentPrice, sessionData.openingChain, tick, sessionData.pricePath.length, iv)
  }, [sessionData, currentPrice, tick, iv])

  const handleBuy = useCallback((strike: number, type: 'call' | 'put') => {
    const option = repricedChain.find(r => r.strike === strike && r.type === type)
    if (!option) return
    setPaperTrades(prev => [...prev, {
      id: Date.now().toString(),
      strike,
      type,
      action: 'buy',
      entryPrice: option.ask,
      entryTick: tick,
      quantity: 1,
      status: 'open',
    }])
  }, [repricedChain, tick])

  const handleSell = useCallback((strike: number, type: 'call' | 'put') => {
    const option = repricedChain.find(r => r.strike === strike && r.type === type)
    if (!option) return
    setPaperTrades(prev => [...prev, {
      id: Date.now().toString(),
      strike,
      type,
      action: 'sell',
      entryPrice: option.bid,
      entryTick: tick,
      quantity: 1,
      status: 'open',
    }])
  }, [repricedChain, tick])

  const closeTrade = useCallback((id: string) => {
    setPaperTrades(prev => prev.map(t => {
      if (t.id !== id || t.status !== 'open') return t
      const option = repricedChain.find(r => r.strike === t.strike && r.type === t.type)
      if (!option) return t
      const exitPrice = t.action === 'buy' ? option.bid : option.ask
      const pnl = t.action === 'buy'
        ? (exitPrice - t.entryPrice) * t.quantity
        : (t.entryPrice - exitPrice) * t.quantity
      return { ...t, status: 'closed' as const, exitPrice, exitTick: tick, pnl }
    }))
  }, [repricedChain, tick])

  useEffect(() => {
    if (!autoPilot || !sessionData) return
    const tickPct = tick / (sessionData.pricePath.length - 1)
    if (tickPct < 0.3) return

    const openTrades = paperTrades.filter(t => t.status === 'open')
    for (const t of openTrades) {
      const option = repricedChain.find(r => r.strike === t.strike && r.type === t.type)
      if (!option) continue
      const currentVal = t.action === 'buy' ? option.bid : option.ask
      const unrealized = t.action === 'buy'
        ? (currentVal - t.entryPrice) / t.entryPrice * 100
        : (t.entryPrice - currentVal) / t.entryPrice * 100

      if (unrealized >= tpPct) closeTrade(t.id)
      else if (unrealized <= -slPct) closeTrade(t.id)
    }
  }, [autoPilot, tick, sessionData, paperTrades, repricedChain, tpPct, slPct, closeTrade])

  if (loading) return <div className="text-center py-12 text-ztextdim animate-pulse">Loading session...</div>
  if (!sessionData) return <div className="text-center py-12 text-ztextdim">Select a session date.</div>

  const totalTicks = sessionData.pricePath.length
  const progress = tick / (totalTicks - 1)
  const pnl = paperTrades.reduce((s, t) => s + (t.pnl || 0), 0)

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setPlaying(p => !p)}
            className={`px-4 py-1.5 text-sm font-medium rounded ${
              playing ? 'bg-zred/20 text-zred border border-zred' : 'bg-zcyan/20 text-zcyan border border-zcyan'
            }`}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            onClick={() => { setTick(0); setPlaying(false) }}
            className="px-3 py-1.5 text-xs text-ztextdim border border-zborder rounded hover:text-ztext"
          >
            Reset
          </button>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Speed:</label>
            <select value={speed} onChange={e => setSpeed(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext">
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={5}>5x</option>
              <option value={10}>10x</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">IV:</label>
            <input type="range" min={5} max={80} value={iv * 100} onChange={e => setIv(Number(e.target.value) / 100)} className="w-20" />
            <span className="text-xs font-mono text-ztext">{(iv * 100).toFixed(0)}%</span>
          </div>
        </div>
        <div className="mt-3">
          <div className="flex justify-between text-xs text-ztextdim mb-1">
            <span>{sessionData.pricePath[0]?.time}</span>
            <span>{sessionData.pricePath[tick]?.time}</span>
            <span>{sessionData.pricePath[sessionData.pricePath.length - 1]?.time}</span>
          </div>
          <div className="h-1.5 bg-zborder rounded-full overflow-hidden">
            <div className="h-full bg-zcyan rounded-full transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      </div>

      {/* Price Chart */}
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-ztextdim">Price Replay</h3>
          <span className="text-lg font-semibold text-white font-mono">${currentPrice.toFixed(2)}</span>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={sessionData.pricePath.slice(0, tick + 1)}>
            <defs>
              <linearGradient id="replayGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#6b7280' }} />
            <YAxis domain={['dataMin - 2', 'dataMax + 2']} tick={{ fontSize: 10, fill: '#6b7280' }} />
            <Tooltip
              contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 8, fontSize: 12 }}
            />
            <Area type="monotone" dataKey="price" stroke="#06b6d4" fill="url(#replayGrad)" strokeWidth={2} />
            <Line type="monotone" dataKey="price" stroke="#06b6d4" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Repriced Chain */}
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Repriced Chain (BSM, spot=${currentPrice.toFixed(0)})</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <MiniChainTable title="CALLS" rows={repricedChain.filter(r => r.type === 'call').slice(0, 15)} color="text-zgreen" showActions onBuy={handleBuy} onSell={handleSell} />
          <MiniChainTable title="PUTS" rows={repricedChain.filter(r => r.type === 'put').slice(0, 15)} color="text-zred" showActions onBuy={handleBuy} onSell={handleSell} />
        </div>
      </div>

      {/* Paper Trades */}
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-ztextdim">Paper Trades</h3>
          <div className="flex items-center gap-3">
            <span className={`text-sm font-mono font-semibold ${pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>
              P&L: ${pnl.toFixed(2)}
            </span>
            <span className="text-xs text-ztextdim">{paperTrades.filter(t => t.status === 'open').length} open</span>
          </div>
        </div>

        {paperTrades.length === 0 ? (
          <p className="text-xs text-ztextdim">Click buy/sell on chain rows above to enter paper trades.</p>
        ) : (
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-ztextdim border-b border-zborder">
                <tr>
                  <th className="text-left px-2 py-1">#</th>
                  <th className="text-left px-2 py-1">Strike</th>
                  <th className="text-left px-2 py-1">Type</th>
                  <th className="text-right px-2 py-1">Entry</th>
                  <th className="text-right px-2 py-1">Current</th>
                  <th className="text-right px-2 py-1">P&L</th>
                  <th className="text-center px-2 py-1">Status</th>
                  <th className="text-center px-2 py-1">Action</th>
                </tr>
              </thead>
              <tbody>
                {paperTrades.map(t => {
                  const option = repricedChain.find(r => r.strike === t.strike && r.type === t.type)
                  const curVal = t.action === 'buy' ? option?.bid || 0 : option?.ask || 0
                  const unrealizedPnl = t.action === 'buy'
                    ? (curVal - t.entryPrice) * t.quantity
                    : (t.entryPrice - curVal) * t.quantity
                  return (
                    <tr key={t.id} className="border-b border-zborder/50">
                      <td className="px-2 py-1 font-mono text-ztextdim">{t.id.slice(-4)}</td>
                      <td className="px-2 py-1 font-mono">{t.strike.toFixed(0)}</td>
                      <td className={`px-2 py-1 ${t.type === 'call' ? 'text-zgreen' : 'text-zred'}`}>{t.type.toUpperCase()}</td>
                      <td className="text-right px-2 py-1 font-mono">${t.entryPrice.toFixed(2)}</td>
                      <td className="text-right px-2 py-1 font-mono">${curVal.toFixed(2)}</td>
                      <td className={`text-right px-2 py-1 font-mono ${t.status === 'closed' ? (t.pnl! >= 0 ? 'text-zgreen' : 'text-zred') : (unrealizedPnl >= 0 ? 'text-zgreen' : 'text-zred')}`}>
                        ${t.status === 'closed' ? t.pnl!.toFixed(2) : unrealizedPnl.toFixed(2)}
                      </td>
                      <td className={`text-center px-2 py-1 ${t.status === 'closed' ? 'text-ztextdim' : 'text-zyellow'}`}>
                        {t.status === 'closed' ? 'Closed' : 'Open'}
                      </td>
                      <td className="text-center px-2 py-1">
                        {t.status === 'open' && (
                          <button onClick={() => closeTrade(t.id)} className="text-xs text-zred hover:text-zred/80">
                            Close
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Auto-Pilot */}
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoPilot} onChange={e => setAutoPilot(e.target.checked)} className="accent-zcyan" />
            <span className="text-ztext">Auto-Pilot</span>
          </label>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">TP:</label>
            <input type="number" value={tpPct} onChange={e => setTpPct(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" />
            <span className="text-xs text-ztextdim">%</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">SL:</label>
            <input type="number" value={slPct} onChange={e => setSlPct(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" />
            <span className="text-xs text-ztextdim">%</span>
          </div>
          <span className="text-xs text-ztextdim">
            Auto-pilot closes trades when P&L hits TP or SL (activates after 30% of session).
          </span>
        </div>
      </div>
    </div>
  )
}

function MiniChainTable({ title, rows, color, showActions, onBuy, onSell }: {
  title: string; rows: OptionRow[]; color: string;
  showActions?: boolean; onBuy?: (strike: number, type: 'call' | 'put') => void; onSell?: (strike: number, type: 'call' | 'put') => void
}) {
  return (
    <div className="bg-zdark/50 border border-zborder rounded overflow-hidden">
      <div className={`px-3 py-1.5 text-xs font-semibold ${color} border-b border-zborder`}>
        {title} ({rows.length})
      </div>
      <table className="w-full text-xs">
        <thead className="text-ztextdim">
          <tr className="border-b border-zborder/50">
            <th className="text-left px-2 py-1">Strike</th>
            <th className="text-right px-2 py-1">Bid</th>
            <th className="text-right px-2 py-1">Ask</th>
            <th className="text-right px-2 py-1">Mid</th>
            {showActions && <th className="text-center px-2 py-1">Trade</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={`${r.strike}-${r.type}`} className="border-b border-zborder/20 hover:bg-zgray/10">
              <td className={`px-2 py-1 font-mono ${color}`}>{r.strike.toFixed(0)}</td>
              <td className="text-right px-2 py-1 font-mono">{r.bid.toFixed(2)}</td>
              <td className="text-right px-2 py-1 font-mono">{r.ask.toFixed(2)}</td>
              <td className="text-right px-2 py-1 font-mono">{r.mid.toFixed(2)}</td>
              {showActions && (
                <td className="text-center px-2 py-1">
                  <button onClick={() => onBuy?.(r.strike, r.type)} className="text-xs text-zgreen hover:text-zgreen/80 mr-1">Buy</button>
                  <button onClick={() => onSell?.(r.strike, r.type)} className="text-xs text-zred hover:text-zred/80">Sell</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
