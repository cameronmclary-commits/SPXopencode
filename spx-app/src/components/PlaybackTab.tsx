import { useState, useEffect, useRef } from 'react'
import type { SessionInfo, ChainSnapshot, OptionRow } from '../types'
import { usePlayback, type PlaybackSpeed } from '../hooks/usePlayback'
import { findBestCombo, type ComboLeg } from '../utils/combos'
import { surfacePrice, numericDelta } from '../utils/pricing'

interface Props {
  sessions: SessionInfo[]
}

interface ScanParams {
  maxCost: number
  templateMove: number
  minPnl: number
  minDelta: number
}

interface SuggestedCombo {
  id: string
  type: 'call' | 'put'
  legs: ComboLeg[]
  totalCost: number
  templatePts: number
}

export default function PlaybackTab({ sessions }: Props) {
  const [selectedDate, setSelectedDate] = useState(sessions[0]?.date || '')
  const [snapshots, setSnapshots] = useState<ChainSnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [params, setParams] = useState<ScanParams>({
    maxCost: 50,
    templateMove: 10,
    minPnl: 0,
    minDelta: 0.15,
  })
  const [suggestions, setSuggestions] = useState<SuggestedCombo[]>([])
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
      })
      .catch(() => setSnapshots([]))
      .finally(() => setLoading(false))
  }, [selectedDate])

  useEffect(() => {
    if (!pb.current) { setSuggestions([]); return }
    const { spot, chain } = pb.current
    const baseSpot = snapshots[0]?.spot || spot
    const priceShift = spot - baseSpot

    const calls = chain.filter(r => r.type === 'call')
    const puts = chain.filter(r => r.type === 'put')
    const combos: SuggestedCombo[] = []

    for (const c of calls) {
      if (params.minDelta > 0 && c.delta != null && Math.abs(c.delta) < params.minDelta) continue
      for (const p of puts) {
        if (params.minDelta > 0 && p.delta != null && Math.abs(p.delta) < params.minDelta) continue
        for (let pQty = 1; pQty <= 3; pQty++) {
          const cost = surfacePrice(chain, c.strike, 'call', priceShift, spot) +
            surfacePrice(chain, p.strike, 'put', priceShift, spot) * pQty
          if (cost <= 0 || cost > params.maxCost) continue

          const ptsUp = (surfacePrice(chain, c.strike, 'call', priceShift + params.templateMove, spot) -
            surfacePrice(chain, p.strike, 'put', priceShift + params.templateMove, spot) * pQty) - cost
          const ptsDown = (surfacePrice(chain, c.strike, 'call', priceShift - params.templateMove, spot) -
            surfacePrice(chain, p.strike, 'put', priceShift - params.templateMove, spot) * pQty) - cost

          if (ptsUp >= params.minPnl && ptsDown >= params.minPnl) {
            combos.push({
              id: `c${c.strike}_p${p.strike}_x${pQty}`,
              type: 'call',
              legs: [
                { strike: c.strike, type: 'call', quantity: 1, bid: c.bid, ask: c.ask, mid: c.mid, conid: c.conid },
                { strike: p.strike, type: 'put', quantity: pQty, bid: p.bid, ask: p.ask, mid: p.mid, conid: p.conid },
              ],
              totalCost: Math.round(cost * 100) / 100,
              templatePts: params.templateMove,
            })
          }
        }
      }
    }

    combos.sort((a, b) => b.templatePts - a.templatePts || a.totalCost - b.totalCost)
    setSuggestions(combos.slice(0, 3))
  }, [pb.current, params, snapshots])

  function updateParam<K extends keyof ScanParams>(key: K, val: ScanParams[K]) {
    setParams(p => ({ ...p, [key]: val }))
  }

  const snapshot = pb.current
  const baseSpot = snapshots[0]?.spot || 0
  const spotChange = snapshot ? snapshot.spot - baseSpot : 0
  const spotChangePct = baseSpot > 0 ? (spotChange / baseSpot * 100) : 0

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
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Min P&L</label>
                      <input type="number" value={params.minPnl} onChange={e => updateParam('minPnl', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={0.1} />
                    </div>
                    <div>
                      <label className="text-[10px] text-ztextdim tracking-wide uppercase">Min Delta</label>
                      <input type="number" value={params.minDelta} onChange={e => updateParam('minDelta', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full" step={0.05} />
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
                          <div className="text-[10px] text-ztextdim mt-1">
                            Template: <span className="text-zcyan">+{s.templatePts} pts</span>
                          </div>
                        </div>
                      ))}
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
