import { useState, useEffect, useRef, useCallback } from 'react'
import type { SessionInfo, ChainSnapshot } from '../types'
import { usePlayback, type PlaybackSpeed } from '../hooks/usePlayback'
import { findBestCombo } from '../utils/combos'
import { surfacePrice } from '../utils/pricing'
import { comboCostHistory, rollingZscore } from '../utils/signals'

interface Props {
  sessions: SessionInfo[]
}

interface ScanParams {
  maxCost: number
  templateMove: number
  minPnl10: number
  minPnl: number
  minPnlHalf: number
  minSideDelta: number
  minBalance: number
  minGap: number
  minSpotGap: number
  maxStep: number
}

interface SuggestedCombo {
  id: string
  type: 'call' | 'put'
  legs: { strike: number; type: 'call' | 'put'; quantity: number; mid: number; conid?: number }[]
  totalCost: number
  templatePts: number
}

interface PlaybackTrade {
  id: string
  combo: SuggestedCombo
  entrySnapshotIndex: number
  entryTime: string
  entryCost: number
  exitSnapshotIndex?: number
  exitTime?: string
  exitValue?: number
  pnl?: number
  status: 'open' | 'closed'
}

interface SignalPoint {
  time: string
  cost: number
  zscore: number | null
}

function comboAskCost(combo: SuggestedCombo, snapshot: ChainSnapshot): number {
  return combo.legs.reduce((sum, leg) => {
    return sum + leg.quantity * surfacePrice(snapshot.chain, leg.strike, leg.type, 0, true)
  }, 0)
}

function comboBidValue(combo: SuggestedCombo, snapshot: ChainSnapshot): number {
  return combo.legs.reduce((sum, leg) => {
    return sum + leg.quantity * surfacePrice(snapshot.chain, leg.strike, leg.type, 0, false)
  }, 0)
}

export default function PlaybackTab({ sessions }: Props) {
  const [selectedDate, setSelectedDate] = useState(sessions[0]?.date || '')
  const [snapshots, setSnapshots] = useState<ChainSnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [params, setParams] = useState<ScanParams>({
    maxCost: 70,
    templateMove: 10,
    minPnl10: 1,
    minPnl: 0,
    minPnlHalf: 0,
    minSideDelta: 0.5,
    minBalance: 0.7,
    minGap: 5,
    minSpotGap: 3,
    maxStep: 10,
  })
  const [suggestions, setSuggestions] = useState<SuggestedCombo[]>([])
  const [trades, setTrades] = useState<PlaybackTrade[]>([])
  const [signalHistory, setSignalHistory] = useState<SignalPoint[]>([])
  const timelineRef = useRef<HTMLDivElement>(null)

  const pb = usePlayback(snapshots)

  useEffect(() => {
    if (!selectedDate) return
    setLoading(true)
    fetch(`/api/sessions/${selectedDate}/snapshots`)
      .then(r => r.json())
      .then(data => {
        setSnapshots(data.snapshots || [])
        setSuggestions([])
        setTrades([])
      })
      .catch(() => setSnapshots([]))
      .finally(() => setLoading(false))
  }, [selectedDate])

  useEffect(() => {
    const snap = pb.current
    if (!snap) { setSuggestions([]); return }
    const { spot, chain } = snap
    const results = findBestCombo(chain, spot, params.maxCost, params.templateMove, params.minPnl10, params.minPnl, params.minPnlHalf, params.minSideDelta, params.minBalance, params.minGap, params.minSpotGap, params.maxStep, 3)
    setSuggestions(results.map((r, i) => {
      const itmType = r.legs[0].type
      return {
        id: `sug_${i}_${Date.now()}`,
        type: itmType,
        legs: r.legs.map(l => ({
          strike: l.strike, type: l.type, quantity: l.quantity,
          mid: Math.round((l.entryAsk + l.entryBid) / 2 * 10000) / 10000,
          conid: l.conid,
        })),
        totalCost: Math.round(r.cost * 100) / 100,
        templatePts: params.templateMove,
      }
    }))
  }, [pb.index, params, snapshots])

  // Compute combo cost z-score signals for the top suggestion
  useEffect(() => {
    const top = suggestions[0]
    if (!top || snapshots.length < 5) {
      setSignalHistory([])
      return
    }
    const history = comboCostHistory(top.legs, snapshots)
    const lookback = Math.max(5, Math.min(15, Math.floor(snapshots.length / 3)))
    const zscores = rollingZscore(history.map(h => h.cost), lookback)
    setSignalHistory(history.map((h, i) => ({ ...h, zscore: zscores[i] })))
  }, [suggestions[0], snapshots])

  // Auto-close open trades when playback reaches end
  useEffect(() => {
    if (!pb.atEnd || !pb.current) return
    const currentSnap = pb.current
    setTrades(prev => prev.map(t => {
      if (t.status !== 'open') return t
      const exitValue = comboBidValue(t.combo, currentSnap)
      return {
        ...t,
        exitSnapshotIndex: pb.index,
        exitTime: currentSnap.time,
        exitValue: exitValue,
        pnl: exitValue - t.entryCost,
        status: 'closed',
      }
    }))
  }, [pb.atEnd])

  const handleTakeTrade = useCallback((combo: SuggestedCombo) => {
    if (!pb.current) return
    const entryCost = comboAskCost(combo, pb.current)
    const trade: PlaybackTrade = {
      id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      combo,
      entrySnapshotIndex: pb.index,
      entryTime: pb.current.time,
      entryCost,
      status: 'open',
    }
    setTrades(prev => [...prev, trade])
  }, [pb.current, pb.index])

  const handleCloseTrade = useCallback((tradeId: string) => {
    if (!pb.current) return
    setTrades(prev => prev.map(t => {
      if (t.id !== tradeId || t.status !== 'open') return t
      const exitValue = comboBidValue(t.combo, pb.current!)
      return {
        ...t,
        exitSnapshotIndex: pb.index,
        exitTime: pb.current!.time,
        exitValue,
        pnl: exitValue - t.entryCost,
        status: 'closed',
      }
    }))
  }, [pb.current, pb.index])

  function updateParam<K extends keyof ScanParams>(key: K, val: ScanParams[K]) {
    setParams(p => ({ ...p, [key]: val }))
  }

  const snapshot = pb.current
  const baseSpot = snapshots[0]?.spot || 0
  const spotChange = snapshot ? snapshot.spot - baseSpot : 0
  const spotChangePct = baseSpot > 0 ? (spotChange / baseSpot * 100) : 0
  
  const currentSignal = pb.index < signalHistory.length ? signalHistory[pb.index] : null
  const signalColor = !currentSignal?.zscore ? 'text-ztextdim' :
    Math.abs(currentSignal.zscore) >= 2 ? 'text-zgreen' :
    Math.abs(currentSignal.zscore) >= 1 ? 'text-zyellow' : 'text-ztextdim'

  const openTrades = trades.filter(t => t.status === 'open')
  const closedTrades = trades.filter(t => t.status === 'closed')
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0) +
    openTrades.reduce((sum, t) => {
      if (!pb.current) return sum
      const currentValue = comboBidValue(t.combo, pb.current)
      return sum + (currentValue - t.entryCost)
    }, 0)

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="panel-bg border border-zborder rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-ztextdim tracking-wide">Playback</h3>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-ztextdim tracking-wide uppercase">Session</label>
            <select
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext"
            >
              {sessions.map(s => <option key={s.date} value={s.date}>{s.date}</option>)}
            </select>
          </div>
        </div>

        {loading && <div className="text-xs text-ztextdim animate-pulse py-4 text-center">Loading snapshots...</div>}

        {!loading && snapshots.length === 0 && (
          <div className="text-xs text-ztextdim py-4 text-center">
            No intraday snapshots available for this session.
            <br />
            <span className="text-ztextdim/60">Playback requires multiple chain snapshots throughout the day.</span>
          </div>
        )}

        {snapshots.length > 0 && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="panel-bg border border-zborder rounded-lg p-3">
                <div className="text-[10px] text-ztextdim tracking-wide uppercase">Time</div>
                <div className="text-lg font-semibold font-mono text-white">{snapshot?.time || '—'}</div>
              </div>
              <div className="panel-bg border border-zborder rounded-lg p-3">
                <div className="text-[10px] text-ztextdim tracking-wide uppercase">SPX</div>
                <div className="text-lg font-semibold font-mono text-white">{snapshot?.spot.toFixed(2) || '—'}</div>
                <div className={`text-[10px] font-mono ${spotChange >= 0 ? 'text-zgreen' : 'text-zred'}`}>
                  {spotChange >= 0 ? '+' : ''}{spotChange.toFixed(2)} ({spotChangePct.toFixed(2)}%)
                </div>
              </div>
              <div className="panel-bg border border-zborder rounded-lg p-3">
                <div className="text-[10px] text-ztextdim tracking-wide uppercase">Strikes</div>
                <div className="text-lg font-semibold font-mono text-white">{snapshot?.chain.length || 0}</div>
              </div>
              <div className="panel-bg border border-zborder rounded-lg p-3">
                <div className="text-[10px] text-ztextdim tracking-wide uppercase">Snapshot</div>
                <div className="text-lg font-semibold font-mono text-white">{pb.index + 1} / {pb.total}</div>
              </div>
            </div>

            <div className="flex items-center gap-4 mb-3">
              <div className="flex items-center gap-1">
                <button onClick={pb.seekToStart} disabled={pb.atStart}
                  className="px-2 py-1 text-xs rounded border border-zborder text-ztextdim hover:text-ztext disabled:opacity-30">⏮</button>
                <button onClick={pb.stepBack} disabled={pb.atStart}
                  className="px-2 py-1 text-xs rounded border border-zborder text-ztextdim hover:text-ztext disabled:opacity-30">◀</button>
                <button onClick={pb.toggle}
                  className="px-3 py-1 text-xs rounded border border-zcyan text-zcyan hover:bg-zcyan/10">
                  {pb.playing ? '⏸' : '▶'}
                </button>
                <button onClick={pb.stepForward} disabled={pb.atEnd}
                  className="px-2 py-1 text-xs rounded border border-zborder text-ztextdim hover:text-ztext disabled:opacity-30">▶▶</button>
                <button onClick={pb.seekToEnd} disabled={pb.atEnd}
                  className="px-2 py-1 text-xs rounded border border-zborder text-ztextdim hover:text-ztext disabled:opacity-30">⏭</button>
              </div>

              <div className="flex items-center gap-1">
                {([0.5, 1, 2, 5, 10, 25] as PlaybackSpeed[]).map(s => (
                  <button key={s} onClick={() => pb.setSpeed(s)}
                    className={`px-2 py-1 text-[10px] rounded border ${
                      pb.speed === s ? 'border-zcyan text-zcyan bg-zcyan/10' : 'border-zborder text-ztextdim hover:text-ztext'
                    }`}>
                    {s}x
                  </button>
                ))}
              </div>

              <div className="text-[10px] text-ztextdim">
                Space: play/pause · ←→: step · ↑↓: speed
              </div>
            </div>

            <div ref={timelineRef} className="relative h-8 bg-zgray/30 rounded cursor-pointer mb-1"
              onClick={e => {
                if (!timelineRef.current) return
                const rect = timelineRef.current.getBoundingClientRect()
                const pct = (e.clientX - rect.left) / rect.width
                pb.seek(Math.round(pct * (pb.total - 1)))
              }}>
              <div className="absolute top-0 left-0 h-full bg-zcyan/20 rounded-l transition-all duration-75"
                style={{ width: `${pb.progress * 100}%` }} />
              <div className="absolute top-0 h-full w-0.5 bg-zcyan transition-all duration-75"
                style={{ left: `${pb.progress * 100}%` }} />
              <div className="absolute bottom-full mb-1 text-[10px] text-ztextdim font-mono whitespace-nowrap transition-all duration-75"
                style={{ left: `${pb.progress * 100}%`, transform: 'translateX(-50%)' }}>
                {snapshot?.time}
              </div>
            </div>
            <div className="flex justify-between text-[10px] text-ztextdim/60 mb-4">
              <span>{snapshots[0]?.time}</span>
              <span>{snapshots[snapshots.length - 1]?.time}</span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="panel-bg border border-zborder rounded-lg p-4">
                <h4 className="text-xs font-medium text-ztextdim tracking-wide mb-2">Chain at {snapshot?.time}</h4>
                <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-zdark/95 backdrop-blur-sm">
                      <tr className="text-ztextdim border-b border-zborder">
                        <th className="text-left px-2 py-1 font-medium">K</th>
                        <th className="text-right px-2 py-1 font-medium">Type</th>
                        <th className="text-right px-2 py-1 font-medium">Bid</th>
                        <th className="text-right px-2 py-1 font-medium">Ask</th>
                        <th className="text-right px-2 py-1 font-medium">Mid</th>
                        <th className="text-right px-2 py-1 font-medium">Δ</th>
                        <th className="text-right px-2 py-1 font-medium">IV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot?.chain
                        .filter(r => Math.abs(r.strike - snapshot.spot) < 100)
                        .map(r => {
                          const itm = r.type === 'call' ? r.strike < snapshot.spot : r.strike > snapshot.spot
                          return (
                            <tr key={`${r.strike}-${r.type}`} className="border-b border-zborder/30 hover:bg-zgray/20">
                              <td className={`px-2 py-1 font-mono ${itm ? 'text-zgreen' : 'text-zred'}`}>{r.strike}</td>
                              <td className={`text-right px-2 py-1 font-mono ${r.type === 'call' ? 'text-zgreen' : 'text-zred'}`}>{r.type === 'call' ? 'C' : 'P'}</td>
                              <td className="text-right px-2 py-1 font-mono">{r.bid.toFixed(2)}</td>
                              <td className="text-right px-2 py-1 font-mono">{r.ask.toFixed(2)}</td>
                              <td className="text-right px-2 py-1 font-mono">{r.mid.toFixed(2)}</td>
                              <td className="text-right px-2 py-1 font-mono text-ztextdim">{r.delta != null ? r.delta.toFixed(3) : '—'}</td>
                              <td className="text-right px-2 py-1 font-mono text-ztextdim">{r.iv != null ? (r.iv * 100).toFixed(1) + '%' : '—'}</td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="space-y-4">
                <div className="panel-bg border border-zborder rounded-lg p-4">
                  <h4 className="text-xs font-medium text-ztextdim tracking-wide mb-2">Combo Scanner</h4>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Max Cost</label>
                      <input type="number" value={params.maxCost} onChange={e => updateParam('maxCost', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" />
                    </div>
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Template (pts)</label>
                      <input type="number" value={params.templateMove} onChange={e => updateParam('templateMove', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={2.5} />
                    </div>
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Min P&L 10</label>
                      <input type="number" value={params.minPnl10} onChange={e => updateParam('minPnl10', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={0.1} />
                    </div>
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Min P&L</label>
                      <input type="number" value={params.minPnl} onChange={e => updateParam('minPnl', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={0.1} />
                    </div>
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Min P&L 1/2</label>
                      <input type="number" value={params.minPnlHalf} onChange={e => updateParam('minPnlHalf', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={0.1} />
                    </div>
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Min Side Delta</label>
                      <input type="number" value={params.minSideDelta} onChange={e => updateParam('minSideDelta', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={0.05} />
                    </div>
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Min Balance</label>
                      <input type="number" value={params.minBalance} onChange={e => updateParam('minBalance', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={0.05} />
                    </div>
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Min Gap</label>
                      <input type="number" value={params.minGap} onChange={e => updateParam('minGap', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={5} />
                    </div>
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Max Step</label>
                      <input type="number" value={params.maxStep} onChange={e => updateParam('maxStep', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={1} />
                    </div>
                  </div>

                  {suggestions.length === 0 ? (
                    <div className="text-xs text-ztextdim py-2">No combos found at current snapshot</div>
                  ) : (
                    <div className="space-y-2">
                      {suggestions.map((s, i) => (
                        <div key={s.id} className={`panel-bg border rounded-lg p-3 ${i === 0 ? 'border-zgreen/40' : 'border-zborder'}`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className={`text-xs font-medium ${s.type === 'call' ? 'text-zgreen' : 'text-zred'}`}>
                              {i === 0 ? '★ ' : ''}{s.type.toUpperCase()} Combo
                            </span>
                            <span className="text-xs font-mono text-zyellow">{s.totalCost.toFixed(2)} pts</span>
                          </div>
                          <div className="space-y-0.5">
                            {s.legs.map((l, j) => (
                              <div key={j} className="text-[10px] text-ztextdim font-mono">
                                {l.type === 'call' ? 'C' : 'P'} {l.strike} × {l.quantity}
                                <span className="text-ztextdim/60 ml-1">({l.mid.toFixed(2)})</span>
                              </div>
                            ))}
                          </div>
                          <div className="flex items-center justify-between mt-2">
                            <div className="text-[10px] text-ztextdim">
                              Template: <span className="text-zcyan">+{s.templatePts} pts</span>
                            </div>
                            <button onClick={() => handleTakeTrade(s)}
                              className="text-[10px] px-2 py-0.5 rounded border border-zgreen/40 text-zgreen hover:bg-zgreen/10">
                              Take Trade
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Signals Panel */}
                {signalHistory.length > 0 && (
                  <div className="panel-bg border border-zborder rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-medium text-ztextdim tracking-wide">Signals</h4>
                      <span className={`text-sm font-mono font-semibold ${signalColor}`}>
                        z={currentSignal?.zscore != null ? currentSignal.zscore.toFixed(2) : '—'}
                      </span>
                    </div>
                    {suggestions[0] && (
                      <div className="text-[10px] text-ztextdim/60 mb-2 font-mono">
                        {suggestions[0].legs.map(l => `${l.type === 'call' ? 'C' : 'P'} ${l.strike}×${l.quantity}`).join(' ')}
                      </div>
                    )}
                    <div className="flex items-end h-12 gap-px mb-1">
                      {signalHistory.map((s, i) => {
                        if (s.zscore == null) return <div key={i} className="flex-1 h-0.5 bg-ztextdim/10 rounded" />
                        const h = Math.min(Math.abs(s.zscore) / 3 * 100, 100)
                        const color = s.zscore > 0
                          ? (s.zscore >= 2 ? 'bg-zgreen' : s.zscore >= 1 ? 'bg-zgreen/50' : 'bg-ztextdim/30')
                          : (s.zscore <= -2 ? 'bg-zred' : s.zscore <= -1 ? 'bg-zred/50' : 'bg-ztextdim/30')
                        const isActive = i === pb.index
                        return (
                          <div key={i} className="flex-1 flex flex-col-reverse items-center h-full relative">
                            <div
                              className={`w-full ${color} rounded-t transition-all duration-150 ${isActive ? 'ring-1 ring-white' : ''}`}
                              style={{ height: `${h}%` }}
                            />
                            {isActive && (
                              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-1 h-1 bg-white rounded-full" />
                            )}
                          </div>
                        )
                      })}
                    </div>
                    <div className="flex justify-between text-[9px] text-ztextdim/40">
                      <span>Entry</span>
                      <div className="flex gap-3">
                        <span className="text-zgreen/60">+1σ</span>
                        <span className="text-zred/60">-1σ</span>
                        <span className="text-zgreen">+2σ</span>
                        <span className="text-zred">-2σ</span>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2 text-[10px]">
                      {currentSignal?.zscore != null && currentSignal.zscore <= -1 && (
                        <span className="text-zgreen">⬇ Combo cheap — entry signal</span>
                      )}
                      {currentSignal?.zscore != null && currentSignal.zscore >= 1 && (
                        <span className="text-zred">⬆ Combo expensive — exit signal</span>
                      )}
                      {currentSignal?.zscore != null && Math.abs(currentSignal.zscore) < 1 && (
                        <span className="text-ztextdim/60">Neutral — no signal</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Trades Panel */}
                <div className="panel-bg border border-zborder rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-medium text-ztextdim tracking-wide">Trades</h4>
                    <span className={`text-xs font-mono font-semibold ${totalPnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>
                      P&L: ${totalPnl.toFixed(2)}
                    </span>
                  </div>
                  {trades.length === 0 ? (
                    <div className="text-xs text-ztextdim py-2">No trades taken. Click "Take Trade" on a combo above.</div>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {trades.map(t => {
                        const currentValue = t.status === 'open' && pb.current
                          ? comboBidValue(t.combo, pb.current)
                          : t.exitValue ?? 0
                        const pnl = t.status === 'open' && pb.current
                          ? currentValue - t.entryCost
                          : t.pnl ?? 0
                        return (
                          <div key={t.id} className={`border rounded p-2 ${t.status === 'open' ? 'border-zcyan/30' : 'border-zborder/50'}`}>
                            <div className="flex items-center justify-between">
                              <span className={`text-[10px] font-medium ${t.combo.type === 'call' ? 'text-zgreen' : 'text-zred'}`}>
                                {t.combo.type.toUpperCase()} Combo
                              </span>
                              <span className={`text-[10px] font-mono ${pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>
                                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                              </span>
                            </div>
                            <div className="text-[9px] text-ztextdim font-mono mt-0.5">
                              {t.combo.legs.map(l => `${l.type === 'call' ? 'C' : 'P'} ${l.strike}×${l.quantity}`).join(' ')}
                            </div>
                            <div className="flex items-center justify-between mt-1">
                              <span className="text-[9px] text-ztextdim/60">
                                Entry: {t.entryTime} @ ${t.entryCost.toFixed(2)}
                                {t.status === 'closed' && t.exitTime ? ` → Exit: ${t.exitTime}` : ''}
                              </span>
                              {t.status === 'open' && (
                                <button onClick={() => handleCloseTrade(t.id)}
                                  className="text-[9px] px-1.5 py-0.5 rounded border border-zred/40 text-zred hover:bg-zred/10">
                                  Close
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
