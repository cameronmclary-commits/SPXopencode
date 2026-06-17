import { useState, useEffect, useCallback, useRef } from 'react'
import type { OptionRow } from '../types'
import { findBestCombo, type ComboLeg } from '../utils/combos'
import { surfacePrice } from '../utils/pricing'
import { ParamInput, MetricCard } from './shared/UI'

interface SessionData {
  date: string
  spot: number
  pricePath: { time: string; price: number }[]
  openingChain: OptionRow[]
  snapshots: { time: string; chain: OptionRow[] }[]
}

interface SnapshotCombo {
  time: string
  spot: number
  bestLegs: string
  bestCost: number
  bestScore: number
  bestPnl10Pos: number
  bestPnl10Neg: number
  bestPnl5Pos: number
  bestPnl5Neg: number
  side: string
}

interface ReplayTrade {
  id: number
  entryTime: string
  entryIdx: number
  entrySpot: number
  entryCost: number
  legs: ComboLeg[]
  legsStr: string
  side: string
  exitTime: string
  exitIdx: number
  exitSpot: number
  exitValue: number
  pnl: number
  status: 'open' | 'closed'
}

let tradeIdCounter = 0

export default function LivePlayback() {
  const [sessions, setSessions] = useState<string[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playSpeed, setPlaySpeed] = useState(1000)
  const [trades, setTrades] = useState<ReplayTrade[]>([])
  const [lastComboLegs, setLastComboLegs] = useState<ComboLeg[] | null>(null)
  const chainRef = useRef<OptionRow[]>([])

  const [maxCost, setMaxCost] = useState(90)
  const [templateMove, setTemplateMove] = useState(10)
  const [minPnl10, setMinPnl10] = useState(1)
  const [minPnl, setMinPnl] = useState(0.5)
  const [minPnlHalf, setMinPnlHalf] = useState(0)
  const [minSideDelta, setMinSideDelta] = useState(0.5)
  const [minBalance, setMinBalance] = useState(0.85)
  const [minGap, setMinGap] = useState(15)
  const [minSpotGap, setMinSpotGap] = useState(10)
  const [maxStep, setMaxStep] = useState(10)

  const [scanResults, setScanResults] = useState<SnapshotCombo[]>([])
  const [currentCombo, setCurrentCombo] = useState<SnapshotCombo | null>(null)

  useEffect(() => {
    fetch('/api/sessions').then(r => r.json()).then(d => setSessions(d.sessions?.map((s: any) => s.date) || [])).catch(() => {})
  }, [])

  const loadSession = useCallback(async (date: string) => {
    try {
      const [sessionRes, snapRes] = await Promise.all([
        fetch(`/api/sessions/${date}`),
        fetch(`/api/sessions/${date}/snapshots`),
      ])
      const session = await sessionRes.json()
      const snapData = await snapRes.json()
      const data: SessionData = {
        date,
        spot: session.spotPrice,
        pricePath: session.pricePath || [],
        openingChain: session.openingChain || [],
        snapshots: snapData.snapshots || [],
      }
      if (data.snapshots.length) {
        setSessionData(data)
        setCurrentIdx(0)
        setScanResults([])
        setCurrentCombo(null)
        setTrades([])
        setLastComboLegs(null)
      }
    } catch {
      setSessionData(null)
    }
  }, [])

  useEffect(() => {
    if (!sessionData || !sessionData.snapshots[currentIdx]) return
    const snap = sessionData.snapshots[currentIdx]
    const spot = sessionData.pricePath[currentIdx]?.price || sessionData.spot
    const chain = snap.chain
    chainRef.current = chain
    if (!chain.length || !spot) return

    const results = findBestCombo(chain, spot, maxCost, templateMove, minPnl10, minPnl, minPnlHalf, minSideDelta, minBalance, minGap, minSpotGap, maxStep, 1)

    if (results.length) {
      const best = results[0]
      setLastComboLegs(best.legs)
      const legStr = best.legs.map(l => `${l.type[0]}${l.strike}${l.quantity > 1 ? 'x' + l.quantity : ''}`).join('+')
      const c: SnapshotCombo = {
        time: snap.time,
        spot,
        bestLegs: legStr,
        bestCost: best.cost,
        bestScore: best.score,
        bestPnl10Pos: best.pnlPos,
        bestPnl10Neg: best.pnlNeg,
        bestPnl5Pos: best.pnl5Pos,
        bestPnl5Neg: best.pnl5Neg,
        side: best.legs[0].type,
      }
      setCurrentCombo(c)
      setScanResults(prev => {
        if (prev.length && prev[0].time === snap.time) return prev
        return [c, ...prev]
      })
    } else {
      setCurrentCombo(null)
      setLastComboLegs(null)
    }
  }, [sessionData, currentIdx, maxCost, templateMove, minPnl10, minPnl, minPnlHalf, minSideDelta, minBalance, minGap, minSpotGap, maxStep])

  useEffect(() => {
    if (!playing || !sessionData) return
    const timer = setInterval(() => {
      setCurrentIdx(prev => {
        if (prev >= (sessionData?.snapshots.length || 1) - 1) {
          setPlaying(false)
          return prev
        }
        return prev + 1
      })
    }, playSpeed)
    return () => clearInterval(timer)
  }, [playing, sessionData, playSpeed])

  const takeTrade = () => {
    if (!currentCombo || !lastComboLegs || !sessionData) return
    const openTrade = trades.find(t => t.status === 'open')
    if (openTrade) return
    tradeIdCounter++
    setTrades(prev => [...prev, {
      id: tradeIdCounter,
      entryTime: currentCombo.time,
      entryIdx: currentIdx,
      entrySpot: currentCombo.spot,
      entryCost: currentCombo.bestCost,
      legs: lastComboLegs,
      legsStr: currentCombo.bestLegs,
      side: currentCombo.side,
      exitTime: '',
      exitIdx: 0,
      exitSpot: 0,
      exitValue: 0,
      pnl: 0,
      status: 'open',
    }])
  }

  const closeTrade = (tradeId: number) => {
    if (!sessionData) return
    const snap = sessionData.snapshots[currentIdx]
    const spot = sessionData.pricePath[currentIdx]?.price || sessionData.spot
    setTrades(prev => prev.map(t => {
      if (t.id !== tradeId || t.status !== 'open') return t
      const exitValue = t.legs.reduce((sum, l) =>
        sum + l.quantity * surfacePrice(snap.chain, l.strike, l.type, 0, false), 0)
      return {
        ...t,
        exitTime: snap.time,
        exitIdx: currentIdx,
        exitSpot: spot,
        exitValue: Math.round(exitValue * 100) / 100,
        pnl: Math.round((exitValue - t.entryCost) * 100) / 100,
        status: 'closed',
      }
    }))
  }

  const openTrade = trades.find(t => t.status === 'open')
  const currentPnl = (() => {
    if (!openTrade || !sessionData) return null
    const snap = sessionData.snapshots[currentIdx]
    if (!snap) return null
    const val = openTrade.legs.reduce((sum, l) =>
      sum + l.quantity * surfacePrice(snap.chain, l.strike, l.type, 0, false), 0)
    return Math.round((val - openTrade.entryCost) * 100) / 100
  })()

  const closedTrades = trades.filter(t => t.status === 'closed')
  const totalPnl = closedTrades.reduce((s, t) => s + t.pnl, 0)

  const currentSnap = sessionData?.snapshots[currentIdx]
  const currentPrice = sessionData?.pricePath[currentIdx]?.price

  const exportScans = () => {
    const blob = new Blob([JSON.stringify(scanResults, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `scans-${selectedDate || 'unknown'}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const exportTrades = () => {
    const blob = new Blob([JSON.stringify(trades, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `trades-${selectedDate || 'unknown'}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      {/* Session Selector */}
      <div className="bg-zgray/40 border border-zborder rounded-xl p-5">
        <h2 className="text-lg font-bold text-white mb-3">Session Replay</h2>
        <div className="flex items-center gap-3 mb-3">
          <select value={selectedDate} onChange={e => { setSelectedDate(e.target.value); loadSession(e.target.value) }}
            className="bg-zgray/60 border border-zborder rounded-lg px-3 py-2 text-sm text-white font-mono">
            <option value="">Select a session...</option>
            {sessions.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          {sessionData && (
            <span className="text-xs text-ztextdim">{sessionData.snapshots.length} snapshots</span>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {sessionData && (
            <>
              <button onClick={() => setCurrentIdx(0)}
                className="px-3 py-1 text-xs border border-zborder/40 rounded-lg text-ztextdim hover:text-white">⟪</button>
              <button onClick={() => setCurrentIdx(prev => Math.max(0, prev - 1))}
                className="px-3 py-1 text-xs border border-zborder/40 rounded-lg text-ztextdim hover:text-white">⟨</button>
              <span className="text-xs font-mono text-white">{currentIdx + 1} / {sessionData.snapshots.length}</span>
              <button onClick={() => setCurrentIdx(prev => Math.min(sessionData.snapshots.length - 1, prev + 1))}
                className="px-3 py-1 text-xs border border-zborder/40 rounded-lg text-ztextdim hover:text-white">⟩</button>
              <button onClick={() => setCurrentIdx(sessionData.snapshots.length - 1)}
                className="px-3 py-1 text-xs border border-zborder/40 rounded-lg text-ztextdim hover:text-white">⟫</button>
              <button onClick={() => setPlaying(!playing)}
                className={`px-4 py-1.5 text-xs font-bold rounded-lg ${
                  playing
                    ? 'bg-zgreen/20 text-zgreen border border-zgreen/50'
                    : 'text-ztextdim border border-zborder/40 hover:text-zcyan'
                }`}>
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <select value={playSpeed} onChange={e => setPlaySpeed(Number(e.target.value))}
                className="bg-zgray/60 border border-zborder rounded px-2 py-1 text-xs text-white">
                <option value={200}>5x</option>
                <option value={500}>2x</option>
                <option value={1000}>1x</option>
                <option value={2000}>0.5x</option>
              </select>
            </>
          )}
        </div>
      </div>

      {/* Snapshot & Combo */}
      {sessionData && currentSnap && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-zgray/40 border border-zborder rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-3">Snapshot</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <MetricCard label="Time" value={currentSnap.time} />
              <MetricCard label="SPX" value={(currentPrice || sessionData.spot).toFixed(2)} />
              <MetricCard label="Options" value={`${currentSnap.chain.length}`} />
              <MetricCard label="Price Δ" value={(() => {
                if (!currentIdx || !currentPrice || !sessionData.pricePath[0]) return '-'
                const delta = currentPrice - sessionData.pricePath[0].price
                return `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`
              })()} color={(() => {
                if (!currentIdx || !currentPrice) return ''
                const delta = currentPrice - (sessionData.pricePath[0]?.price || currentPrice)
                return delta >= 0 ? '#22c55e' : '#ef4444'
              })()} />
            </div>
          </div>

          <div className="bg-zgray/40 border border-zborder rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-white">Best Combo</h3>
              {currentCombo && !openTrade && (
                <button onClick={takeTrade}
                  className="px-3 py-1 text-xs font-bold bg-zcyan/20 text-zcyan border border-zcyan/40 rounded-lg hover:bg-zcyan/30">
                  Take Trade
                </button>
              )}
            </div>
            {currentCombo ? (
              <div className="space-y-2 text-xs">
                <div className="font-mono text-white">{currentCombo.bestLegs}</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <MetricCard label="Cost" value={currentCombo.bestCost.toFixed(2)} />
                  <MetricCard label="Score" value={currentCombo.bestScore.toFixed(3)} color="#a855f7" />
                  <MetricCard label="Side" value={currentCombo.side === 'call' ? 'Bullish' : 'Bearish'}
                    color={currentCombo.side === 'call' ? '#22c55e' : '#ef4444'} />
                  <MetricCard label="P&L +10" value={currentCombo.bestPnl10Pos.toFixed(2)}
                    color={currentCombo.bestPnl10Pos >= 0 ? '#22c55e' : '#ef4444'} />
                  <MetricCard label="P&L -10" value={currentCombo.bestPnl10Neg.toFixed(2)}
                    color={currentCombo.bestPnl10Neg >= 0 ? '#22c55e' : '#ef4444'} />
                  <MetricCard label="P&L +5" value={currentCombo.bestPnl5Pos.toFixed(2)}
                    color={currentCombo.bestPnl5Pos >= 0 ? '#22c55e' : '#ef4444'} />
                  <MetricCard label="P&L -5" value={currentCombo.bestPnl5Neg.toFixed(2)}
                    color={currentCombo.bestPnl5Neg >= 0 ? '#22c55e' : '#ef4444'} />
                </div>
              </div>
            ) : (
              <div className="text-xs text-ztextdim">No qualifying combo at this snapshot</div>
            )}
          </div>
        </div>
      )}

      {/* Open Trade */}
      {openTrade && sessionData && currentSnap && (
        <div className="bg-zgray/40 border border-zcyan/30 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-zcyan">Active Trade</h3>
            <button onClick={() => closeTrade(openTrade.id)}
              className="px-3 py-1 text-xs font-bold bg-zred/20 text-zred border border-zred/40 rounded-lg hover:bg-zred/30">
              Close Trade
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <MetricCard label="Entry" value={`${openTrade.entryTime} @ ${openTrade.entrySpot.toFixed(1)}`} />
            <MetricCard label="Legs" value={openTrade.legsStr} />
            <MetricCard label="Cost" value={openTrade.entryCost.toFixed(2)} />
            <MetricCard label="Current P&L" value={`${currentPnl != null ? (currentPnl >= 0 ? '+' : '') + currentPnl.toFixed(2) : '—'}`}
              color={currentPnl != null ? (currentPnl >= 0 ? '#22c55e' : '#ef4444') : ''} />
          </div>
        </div>
      )}

      {/* Scan Parameters */}
      <div className="bg-zgray/40 border border-zborder rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Scan Parameters</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <ParamInput label="Max Cost" value={maxCost} onChange={setMaxCost} min={10} max={100} step={5} />
          <ParamInput label="Template Move" value={templateMove} onChange={setTemplateMove} min={5} max={20} step={1} />
          <ParamInput label="Min P&L 10" value={minPnl10} onChange={setMinPnl10} min={0.5} max={3} step={0.1} />
          <ParamInput label="Min P&L Weak" value={minPnl} onChange={setMinPnl} min={0} max={2} step={0.1} />
          <ParamInput label="Min P&L 1/2" value={minPnlHalf} onChange={setMinPnlHalf} min={-2} max={1} step={0.1} />
          <ParamInput label="Min Side Δ" value={minSideDelta} onChange={setMinSideDelta} min={0.1} max={1} step={0.05} />
          <ParamInput label="Min Balance" value={minBalance} onChange={setMinBalance} min={0.5} max={1} step={0.05} />
          <ParamInput label="Min Gap" value={minGap} onChange={setMinGap} min={0} max={30} step={1} />
          <ParamInput label="Min Spot Gap" value={minSpotGap} onChange={setMinSpotGap} min={0} max={30} step={1} />
          <ParamInput label="Max Step" value={maxStep} onChange={setMaxStep} min={1} max={20} step={1} />
        </div>
      </div>

      {/* SPX Price Path */}
      {sessionData && sessionData.pricePath.length > 1 && (
        <div className="bg-zgray/40 border border-zborder rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Price Path</h3>
          <div className="flex items-end gap-[1px] h-20 overflow-x-auto">
            {sessionData.pricePath.map((p, i) => {
              const min_ = Math.min(...sessionData.pricePath.map(x => x.price))
              const max_ = Math.max(...sessionData.pricePath.map(x => x.price))
              const range = max_ - min_ || 1
              const h = ((p.price - min_) / range) * 100
              const inTrade = trades.some(t => i >= t.entryIdx && (t.status === 'open' || i <= t.exitIdx))
              return (
                <div key={i} title={`${p.time} ${p.price.toFixed(2)}`}
                  className={`w-3 min-w-[4px] rounded-t cursor-pointer ${
                    i === currentIdx ? 'bg-zcyan' : inTrade ? 'bg-zgreen/50' : 'bg-zcyan/30'
                  } hover:bg-zcyan/60`}
                  style={{ height: `${Math.max(5, h)}%` }}
                  onClick={() => setCurrentIdx(i)} />
              )
            })}
          </div>
        </div>
      )}

      {/* Trades */}
      {trades.length > 0 && (
        <div className="bg-zgray/40 border border-zborder rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white">
              Trades
              {closedTrades.length > 0 && (
                <span className="ml-2 text-xs text-ztextdim">
                  Total P&L: <span className={totalPnl >= 0 ? 'text-zgreen' : 'text-zred'}>{totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}</span>
                </span>
              )}
            </h3>
            <button onClick={exportTrades}
              className="px-3 py-1 text-xs border border-zborder/40 rounded-lg text-ztextdim hover:text-white">
              Export JSON
            </button>
          </div>
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-ztextdim border-b border-zborder/40 sticky top-0 bg-zgray">
                  <th className="text-left py-1.5 pr-2">#</th>
                  <th className="text-left pr-2">Entry</th>
                  <th className="text-left pr-2">Legs</th>
                  <th className="text-right pr-2">Cost</th>
                  <th className="text-right pr-2">Exit</th>
                  <th className="text-right pr-2">Val</th>
                  <th className="text-right pr-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {[...trades].reverse().map(t => (
                  <tr key={t.id} className={`border-b border-zborder/20 ${
                    t.status === 'open' ? 'bg-zcyan/5' : ''
                  }`}>
                    <td className="py-1 pr-2 text-ztextdim">{t.id}</td>
                    <td className="py-1 pr-2 font-mono text-ztextdim">{t.entryTime}</td>
                    <td className="py-1 pr-2 font-mono text-white truncate max-w-[160px]">{t.legsStr}</td>
                    <td className="py-1 pr-2 text-right font-mono text-ztextdim">{t.entryCost.toFixed(1)}</td>
                    <td className="py-1 pr-2 font-mono text-ztextdim">{t.status === 'closed' ? t.exitTime : '—'}</td>
                    <td className="py-1 pr-2 text-right font-mono text-ztextdim">{t.status === 'closed' ? t.exitValue.toFixed(1) : '—'}</td>
                    <td className={`py-1 pr-2 text-right font-mono ${
                      t.status === 'open' ? 'text-zcyan' : t.pnl >= 0 ? 'text-zgreen' : 'text-zred'
                    }`}>
                      {t.status === 'open' ? 'open' : (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Scan History */}
      {scanResults.length > 0 && (
        <div className="bg-zgray/40 border border-zborder rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white">Scan History ({scanResults.length} combos found)</h3>
            <button onClick={exportScans}
              className="px-3 py-1 text-xs border border-zborder/40 rounded-lg text-ztextdim hover:text-white">
              Export JSON
            </button>
          </div>
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-ztextdim border-b border-zborder/40 sticky top-0 bg-zgray">
                  <th className="text-left py-1.5 pr-2">Time</th>
                  <th className="text-right pr-2">SPX</th>
                  <th className="text-left px-2">Best Combo</th>
                  <th className="text-right px-2">Cost</th>
                  <th className="text-right px-2">Score</th>
                  <th className="text-right px-2">Side</th>
                  <th className="text-right px-2">+10</th>
                  <th className="text-right px-2">-10</th>
                </tr>
              </thead>
              <tbody>
                {[...scanResults].reverse().map((e, i) => (
                  <tr key={i} className="border-b border-zborder/20 hover:bg-zgray/20 cursor-pointer"
                    onClick={() => {
                      const idx = sessionData?.snapshots.findIndex(s => s.time === e.time)
                      if (idx !== undefined && idx >= 0) setCurrentIdx(idx)
                    }}>
                    <td className="py-1 pr-2 text-ztextdim font-mono">{e.time}</td>
                    <td className="py-1 pr-2 text-right font-mono text-white">{e.spot.toFixed(1)}</td>
                    <td className="py-1 px-2 font-mono text-white truncate max-w-[180px]">{e.bestLegs}</td>
                    <td className="py-1 px-2 text-right font-mono text-ztextdim">{e.bestCost.toFixed(1)}</td>
                    <td className="py-1 px-2 text-right font-mono text-zpurple">{e.bestScore.toFixed(2)}</td>
                    <td className={`py-1 px-2 text-right font-bold ${e.side === 'call' ? 'text-zgreen' : 'text-zred'}`}>
                      {e.side === 'call' ? 'BULL' : 'BEAR'}
                    </td>
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
  )
}
