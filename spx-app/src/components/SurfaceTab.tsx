import { useState, useEffect, useMemo } from 'react'
import type { SessionInfo } from '../types'
import { Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ComposedChart } from 'recharts'

interface ChainRow {
  strike: number
  type: 'call' | 'put'
  bid: number
  ask: number
  mid: number
}

interface Snap {
  time: string
  spot: number
  chain: ChainRow[]
}

interface Props {
  sessions: SessionInfo[]
}

function getColor(val: number, min: number, max: number): string {
  if (max === min) return '#1a1a2e'
  const t = (val - min) / (max - min)
  const r = Math.round(255 * t)
  const b = Math.round(255 * (1 - t))
  return `rgb(${r}, 50, ${b})`
}

export default function SurfaceTab({ sessions }: Props) {
  const [selectedDate, setSelectedDate] = useState(sessions[0]?.date || '')
  const [snapshots, setSnapshots] = useState<Snap[]>([])
  const [loading, setLoading] = useState(false)
  const [snapIdx, setSnapIdx] = useState(0)
  const [view, setView] = useState<'both' | 'call' | 'put'>('both')

  useEffect(() => {
    if (!selectedDate) return
    setLoading(true)
    fetch(`/api/sessions/${selectedDate}/snapshots`)
      .then(r => r.json())
      .then(data => {
        setSnapshots(data.snapshots || [])
        setSnapIdx(0)
      })
      .catch(() => setSnapshots([]))
      .finally(() => setLoading(false))
  }, [selectedDate])

  const current = snapshots[snapIdx]
  const showCalls = view === 'both' || view === 'call'
  const showPuts = view === 'both' || view === 'put'

  const skewData = useMemo(() => {
    if (!current) return []
    const rows: { strike: number; callMid?: number; putMid?: number; callSpread?: number; putSpread?: number }[] = []
    const byStrike = new Map<number, { call?: ChainRow; put?: ChainRow }>()
    for (const r of current.chain) {
      const entry = byStrike.get(r.strike) || {}
      entry[r.type === 'call' ? 'call' : 'put'] = r
      byStrike.set(r.strike, entry)
    }
    for (const [strike, { call, put }] of byStrike) {
      const row: any = { strike }
      if (call && showCalls) { row.callMid = call.mid; row.callSpread = call.ask - call.bid }
      if (put && showPuts) { row.putMid = put.mid; row.putSpread = put.ask - put.bid }
      rows.push(row)
    }
    return rows.sort((a, b) => a.strike - b.strike)
  }, [current, showCalls, showPuts])

  const surfaceData = useMemo(() => {
    if (snapshots.length === 0) return { strikes: [], times: [], grid: [] as number[][] }
    const allStrikes = new Set<number>()
    for (const s of snapshots) {
      for (const r of s.chain) allStrikes.add(r.strike)
    }
    const strikes = [...allStrikes].sort((a, b) => a - b)
    const times = snapshots.map(s => s.time)
    const spots = snapshots.map(s => s.spot)
    const grid = strikes.map(strike => {
      return times.map((_, ti) => {
        const s = snapshots[ti]
        const call = s.chain.find(r => r.strike === strike && r.type === 'call')
        const put = s.chain.find(r => r.strike === strike && r.type === 'put')
        const vals: number[] = []
        if (call && showCalls) vals.push(call.mid)
        if (put && showPuts) vals.push(put.mid)
        return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
      })
    })
    return { strikes, times, spots, grid }
  }, [snapshots, showCalls, showPuts])

  const { gridMin, gridMax } = useMemo(() => {
    let mn = Infinity, mx = -Infinity
    for (const row of surfaceData.grid) {
      for (const v of row) {
        if (v > 0) { mn = Math.min(mn, v); mx = Math.max(mx, v) }
      }
    }
    return { gridMin: mn === Infinity ? 0 : mn, gridMax: mx === -Infinity ? 1 : mx }
  }, [surfaceData])

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="panel-bg border border-zborder rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-ztextdim tracking-wide">Options Surface</h3>
          <div className="flex items-center gap-3">
            <select value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
              className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext">
              {sessions.map(s => <option key={s.date} value={s.date}>{s.date}</option>)}
            </select>
            <div className="flex gap-1">
              {(['both', 'call', 'put'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-2 py-1 text-[10px] rounded border ${view === v ? 'border-zcyan text-zcyan bg-zcyan/10' : 'border-zborder text-ztextdim'}`}>
                  {v === 'both' ? 'All' : v === 'call' ? 'Calls' : 'Puts'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading && <div className="text-xs text-ztextdim animate-pulse py-4 text-center">Loading...</div>}

        {!loading && snapshots.length === 0 && (
          <div className="text-xs text-ztextdim py-4 text-center">No snapshot data available.</div>
        )}

        {snapshots.length > 0 && current && (
          <>
            <div className="flex items-center gap-4 mb-4">
              <div className="text-xs text-ztextdim">
                Snapshot: <span className="text-zcyan font-mono">{current.time}</span>
              </div>
              <div className="text-xs text-ztextdim">
                SPX: <span className="text-white font-mono">{current.spot.toFixed(2)}</span>
              </div>
              <div className="text-xs text-ztextdim">
                Strikes: <span className="text-white font-mono">{current.chain.length}</span>
              </div>
              <div className="flex-1" />
              <div className="text-[10px] text-ztextdim">{snapIdx + 1}/{snapshots.length}</div>
              <input type="range" min={0} max={snapshots.length - 1} value={snapIdx}
                onChange={e => setSnapIdx(Number(e.target.value))}
                className="w-32 accent-zcyan" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="panel-bg border border-zborder rounded-lg p-3">
                <h4 className="text-[10px] text-ztextdim tracking-wide uppercase mb-2">Price Skew at {current.time}</h4>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={skewData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                    <XAxis dataKey="strike" tick={{ fontSize: 9, fill: '#6b7280' }} />
                    <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} />
                    <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 6, fontSize: 11 }} />
                    {showCalls && <Area type="monotone" dataKey="callMid" stroke="#22c55e" fill="#22c55e" fillOpacity={0.1} strokeWidth={2} dot={false} name="Call Mid" />}
                    {showPuts && <Area type="monotone" dataKey="putMid" stroke="#ef4444" fill="#ef4444" fillOpacity={0.1} strokeWidth={2} dot={false} name="Put Mid" />}
                  </ComposedChart>
                </ResponsiveContainer>
                <div className="flex gap-4 mt-1 text-[10px]">
                  {showCalls && <span className="text-zgreen">● Calls</span>}
                  {showPuts && <span className="text-zred">● Puts</span>}
                  <span className="text-ztextdim">|</span>
                  <span className="text-zcyan">SPX @ {current.spot.toFixed(0)}</span>
                </div>
              </div>

              <div className="panel-bg border border-zborder rounded-lg p-3">
                <h4 className="text-[10px] text-ztextdim tracking-wide uppercase mb-2">Bid-Ask Spreads</h4>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={skewData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                    <XAxis dataKey="strike" tick={{ fontSize: 9, fill: '#6b7280' }} />
                    <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} />
                    <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 6, fontSize: 11 }} />
                    {showCalls && <Area type="monotone" dataKey="callSpread" stroke="#22c55e" fill="#22c55e" fillOpacity={0.1} strokeWidth={2} dot={false} name="Call Spread" />}
                    {showPuts && <Area type="monotone" dataKey="putSpread" stroke="#ef4444" fill="#ef4444" fillOpacity={0.1} strokeWidth={2} dot={false} name="Put Spread" />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="panel-bg border border-zborder rounded-lg p-3">
              <h4 className="text-[10px] text-ztextdim tracking-wide uppercase mb-2">Price Surface (mid price across strikes × time)</h4>
              <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
                <table className="text-[9px] font-mono border-collapse">
                  <thead>
                    <tr className="sticky top-0 bg-zdark z-10">
                      <th className="text-right px-1 py-0.5 text-ztextdim sticky left-0 bg-zdark z-20 min-w-[50px]">Strike</th>
                      {surfaceData.times.map((t, i) => (
                        <th key={i} className={`px-1 py-0.5 text-center min-w-[32px] ${i === snapIdx ? 'text-zcyan' : 'text-ztextdim'}`}
                          style={i === snapIdx ? { boxShadow: 'inset 0 -2px 0 #06b6d4' } : undefined}>
                          {t.slice(-5)}
                        </th>
                      ))}
                    </tr>
                    <tr className="sticky top-[22px] bg-zdark/95 z-10">
                      <th className="text-right px-1 py-0.5 text-[8px] text-ztextdim/40 sticky left-0 bg-zdark z-20">Spot</th>
                      {surfaceData.spots?.map((sp, i) => (
                        <th key={i} className={`px-1 py-0.5 text-center text-[8px] ${i === snapIdx ? 'text-zcyan' : 'text-ztextdim/40'}`}>
                          {sp.toFixed(0)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {surfaceData.strikes.map((strike, si) => {
                      const row = surfaceData.grid[si]
                      const atm = Math.abs(strike - (current?.spot || 0))
                      return (
                        <tr key={strike}>
                          <td className={`text-right px-1 py-0.5 sticky left-0 bg-zdark z-10 ${atm < 10 ? 'text-zcyan font-bold' : 'text-ztextdim'}`}>
                            {strike}
                          </td>
                          {row.map((v, ti) => {
                            const isAtm = Math.abs(strike - (surfaceData.spots?.[ti] ?? 0)) < 2.5
                            return (
                              <td key={ti}
                                className={`px-1 py-0.5 text-center ${ti === snapIdx ? 'ring-1 ring-zcyan' : ''} ${isAtm ? 'ring-1 ring-white/40' : ''}`}
                                style={{ backgroundColor: v > 0 ? getColor(v, gridMin, gridMax) : 'transparent', color: v > (gridMin + gridMax) / 2 ? '#fff' : '#9ca3af' }}>
                                {v > 0 ? v.toFixed(1) : '—'}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2 mt-2 text-[9px] text-ztextdim">
                <span>Low</span>
                <div className="flex-1 h-2 rounded" style={{ background: 'linear-gradient(to right, rgb(0,50,255), rgb(255,50,0))' }} />
                <span>High</span>
                <span className="ml-4 text-zcyan">● Highlighted column = selected snapshot</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
