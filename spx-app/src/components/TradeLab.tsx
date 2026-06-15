import { useState, useEffect, useRef, useMemo } from 'react'
import type { SessionData, ChainSnapshot } from '../types'
import { fetchSession } from '../api'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { findBestCombo, type ComboLeg } from '../utils/combos'
import { ParamInput, TimeInput } from './shared/UI'

interface Props {
  selectedDate: string
}

interface ForwardTrade {
  id: string; legs: ComboLeg[]; entryCost: number; entryTick: number; entryTime: string
  exitTick?: number; exitTime?: string; exitValue?: number; pnl?: number
  exitReason?: string; status: 'open' | 'closed'
}

export default function TradeLab({ selectedDate }: Props) {
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [snapshots, setSnapshots] = useState<ChainSnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [tick, setTick] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [params, setParams] = useState({
    maxCost: 50, templateMove: 10, minPnl: 0, minDelta: 0,
    tpPoints: 1, slPoints: 2, scanInterval: 5,
    sessionStart: '09:30', sessionEnd: '16:00',
  })
  const [trades, setTrades] = useState<ForwardTrade[]>([])
  const [cumPnl, setCumPnl] = useState(0)
  const openTradeRef = useRef<ForwardTrade | null>(null)
  const nextScanRef = useRef(-1)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!selectedDate) return
    setLoading(true); setTick(0); setPlaying(false)
    setTrades([]); setCumPnl(0)
    openTradeRef.current = null; nextScanRef.current = -1
    Promise.all([
      fetchSession(selectedDate),
      fetch(`/api/sessions/${selectedDate}/snapshots`).then(r => r.json()).then(d => d.snapshots || []),
    ])
      .then(([session, snaps]) => { setSessionData(session); setSnapshots(snaps) })
      .catch(() => { setSessionData(null); setSnapshots([]) })
      .finally(() => setLoading(false))
  }, [selectedDate])

  useEffect(() => {
    if (!playing || !sessionData) { if (timerRef.current) clearInterval(timerRef.current); return }
    timerRef.current = setInterval(() => {
      setTick(t => {
        if (t >= sessionData.pricePath.length - 1) { setPlaying(false); return t }
        return t + 1 * speed
      })
    }, 100)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [playing, sessionData, speed])

  const currentPrice = sessionData?.pricePath[tick]?.price || 0
  const currentTime = sessionData?.pricePath[tick]?.time || ''
  const currentChain = useMemo(() => snapshots[tick]?.chain || sessionData?.openingChain || [], [snapshots, tick, sessionData])

  function timeToMinutes(t: string) { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  function timeInRange(t: string, start: string, end: string) { return t >= start && t <= end }

  // Scan & trade logic on each tick
  useEffect(() => {
    if (!sessionData) return
    if (openTradeRef.current) return
    const tickMin = timeToMinutes(currentTime)
    if (tickMin < nextScanRef.current || !timeInRange(currentTime, params.sessionStart, params.sessionEnd)) return
    const results = findBestCombo(currentChain, currentPrice, params.maxCost, params.templateMove, params.minPnl, params.minDelta)
    if (!results.length) return
    const pos = results[0]
    const trade: ForwardTrade = {
      id: `ft_${Date.now()}`,
      legs: pos.legs, entryCost: pos.cost,
      entryTick: tick, entryTime: currentTime,
      status: 'open',
    }
    openTradeRef.current = trade
    nextScanRef.current = tickMin + params.scanInterval
  }, [tick, sessionData, currentChain, currentPrice, currentTime, params])

  // Monitor open trade for TP/SL
  useEffect(() => {
    const ot = openTradeRef.current
    if (!ot || !sessionData) return
    if (tick === ot.entryTick) return
    const currentVal = ot.legs.reduce((s, l) => {
      const opt = currentChain.find(r => r.strike === l.strike && r.type === l.type)
      return s + l.quantity * (opt?.bid ?? 0)
    }, 0)
    const pnl = currentVal - ot.entryCost

    let reason = ''
    if (pnl >= params.tpPoints) reason = 'TP'
    else if (pnl <= -params.slPoints) reason = 'SL'

    if (reason) {
      const closed = { ...ot, exitTick: tick, exitTime: currentTime, exitValue: currentVal, pnl, exitReason: reason, status: 'closed' as const }
      setTrades(prev => [...prev, closed])
      setCumPnl(prev => prev + pnl)
      openTradeRef.current = null
    }
  }, [tick, sessionData, currentChain, currentTime, params])

  // Auto-close at end of session
  useEffect(() => {
    const ot = openTradeRef.current
    if (!ot || !sessionData) return
    if (tick < sessionData.pricePath.length - 1) return
    const currentVal = ot.legs.reduce((s, l) => {
      const opt = currentChain.find(r => r.strike === l.strike && r.type === l.type)
      return s + l.quantity * (opt?.bid ?? 0)
    }, 0)
    const pnl = currentVal - ot.entryCost
    const closed = { ...ot, exitTick: tick, exitTime: currentTime, exitValue: currentVal, pnl, exitReason: 'EOS', status: 'closed' as const }
    setTrades(prev => [...prev, closed])
    setCumPnl(prev => prev + pnl)
    openTradeRef.current = null
  }, [tick, sessionData])

  if (loading) return <div className="text-center py-12 text-ztextdim animate-pulse">Loading session...</div>
  if (!sessionData) return <div className="text-center py-12 text-ztextdim">Select a session date.</div>

  const totalTicks = sessionData.pricePath.length
  const progress = tick / (totalTicks - 1)
  const allTrades = [...trades, ...(openTradeRef.current ? [openTradeRef.current] : [])]

  return (
    <div className="space-y-4">
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => setPlaying(p => !p)}
            className={`px-4 py-1.5 text-sm font-medium rounded ${playing ? 'bg-zred/20 text-zred border border-zred' : 'bg-zcyan/20 text-zcyan border border-zcyan'}`}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button onClick={() => { setTick(0); setPlaying(false); openTradeRef.current = null; nextScanRef.current = -1 }}
            className="px-3 py-1.5 text-xs text-ztextdim border border-zborder rounded hover:text-ztext">Reset</button>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ztextdim">Speed:</label>
            <select value={speed} onChange={e => setSpeed(Number(e.target.value))} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext">
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={5}>5x</option>
              <option value={10}>10x</option>
              <option value={25}>25x</option>
            </select>
          </div>
          <span className="text-xs text-ztextdim font-mono">{currentTime}</span>
          <span className={`text-xs font-mono font-semibold ${cumPnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>
            P&L: {cumPnl >= 0 ? '+' : ''}{cumPnl.toFixed(2)} pts
          </span>
          {openTradeRef.current && <span className="text-xs text-zyellow animate-pulse">● Active</span>}
        </div>
        <div className="mt-3">
          <div className="flex justify-between text-xs text-ztextdim mb-1">
            <span>{sessionData.pricePath[0]?.time}</span>
            <span className="text-zcyan font-mono">${currentPrice.toFixed(2)}</span>
            <span>{sessionData.pricePath[totalTicks - 1]?.time}</span>
          </div>
          <div className="h-1.5 bg-zborder rounded-full overflow-hidden">
            <div className="h-full bg-zcyan rounded-full transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
          <h3 className="text-sm font-medium text-ztextdim mb-3">Forward-Test Parameters</h3>
          <div className="grid grid-cols-2 gap-3">
            <ParamInput label="Max Cost (pts)" value={params.maxCost} onChange={v => setParams(p => ({ ...p, maxCost: v }))} min={5} max={200} step={5} />
            <ParamInput label="Template (pts)" value={params.templateMove} onChange={v => setParams(p => ({ ...p, templateMove: v }))} min={5} max={20} step={2.5} />
            <ParamInput label="Min P&L (pts)" value={params.minPnl} onChange={v => setParams(p => ({ ...p, minPnl: v }))} min={0} max={5} step={0.1} />
            <ParamInput label="Min Delta" value={params.minDelta} onChange={v => setParams(p => ({ ...p, minDelta: v }))} min={0} max={1} step={0.05} />
            <ParamInput label="Scan Every (min)" value={params.scanInterval} onChange={v => setParams(p => ({ ...p, scanInterval: v }))} min={0.1} max={30} step={0.1} />
            <ParamInput label="TP (pts)" value={params.tpPoints} onChange={v => setParams(p => ({ ...p, tpPoints: v }))} min={0.5} max={10} step={0.5} />
            <ParamInput label="SL (pts)" value={params.slPoints} onChange={v => setParams(p => ({ ...p, slPoints: v }))} min={0.5} max={10} step={0.5} />
            <TimeInput label="Session Start" value={params.sessionStart} onChange={v => setParams(p => ({ ...p, sessionStart: v }))} />
            <TimeInput label="Session End" value={params.sessionEnd} onChange={v => setParams(p => ({ ...p, sessionEnd: v }))} />
          </div>
        </div>

        <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
          <h3 className="text-sm font-medium text-ztextdim mb-3">Price Chart</h3>
          <span className="text-lg font-semibold text-white font-mono">${currentPrice.toFixed(2)}</span>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={sessionData.pricePath.slice(0, tick + 1)}>
              <defs><linearGradient id="ftGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#06b6d4" stopOpacity={0.15} /><stop offset="100%" stopColor="#06b6d4" stopOpacity={0} /></linearGradient></defs>
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#6b7280' }} />
              <YAxis domain={['dataMin', 'dataMax']} tick={{ fontSize: 9, fill: '#6b7280' }} padding={{ top: 20, bottom: 20 }} />
              <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 8, fontSize: 11 }} />
              <Area type="monotone" dataKey="price" stroke="#06b6d4" fill="url(#ftGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-ztextdim">Trades</h3>
          <span className="text-xs text-ztextdim">{allTrades.length} total</span>
        </div>
        {allTrades.length === 0 ? (
          <p className="text-xs text-ztextdim py-2">No trades yet. Press Play — combos will be auto-scanned and traded.</p>
        ) : (
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zdark/95 backdrop-blur-sm">
                <tr className="text-ztextdim border-b border-zborder">
                  <th className="text-left px-2 py-1">Legs</th>
                  <th className="text-right px-2 py-1">Entry</th>
                  <th className="text-right px-2 py-1">Exit</th>
                  <th className="text-right px-2 py-1">P&L</th>
                  <th className="text-center px-2 py-1">Reason</th>
                </tr>
              </thead>
              <tbody>
                {allTrades.map(t => {
                  const pnl = t.status === 'open'
                    ? t.legs.reduce((s, l) => { const o = currentChain.find(r => r.strike === l.strike && r.type === l.type); return s + l.quantity * (o?.bid ?? 0) }, 0) - t.entryCost
                    : t.pnl ?? 0
                  return (
                    <tr key={t.id} className={`border-b border-zborder/50 ${t.status === 'open' ? 'bg-zcyan/5' : ''}`}>
                      <td className="px-2 py-1 font-mono">
                        <span className="text-zgreen">{t.legs.filter(l => l.type === 'call').map(l => `${l.strike.toFixed(0)}×${l.quantity}`).join('+')}</span>
                        {' '}
                        <span className="text-zred">{t.legs.filter(l => l.type === 'put').map(l => `${l.strike.toFixed(0)}×${l.quantity}`).join('+')}</span>
                      </td>
                      <td className="text-right px-2 py-1 font-mono">{t.entryCost.toFixed(2)}<br /><span className="text-[9px] text-ztextdim/60">{t.entryTime}</span></td>
                      <td className="text-right px-2 py-1 font-mono">
                        {t.status === 'open' ? '—' : `${(t.exitValue ?? 0).toFixed(2)}`}
                        {t.status === 'closed' && t.exitTime && <br />}
                        {t.status === 'closed' && t.exitTime && <span className="text-[9px] text-ztextdim/60">{t.exitTime}</span>}
                      </td>
                      <td className={`text-right px-2 py-1 font-mono ${pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>{pnl > 0 ? '+' : ''}{pnl.toFixed(2)}</td>
                      <td className={`text-center px-2 py-1 ${t.status === 'open' ? 'text-zyellow' : t.exitReason === 'TP' ? 'text-zgreen' : t.exitReason === 'SL' ? 'text-zred' : 'text-ztextdim'}`}>
                        {t.status === 'open' ? 'Open' : t.exitReason}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}



