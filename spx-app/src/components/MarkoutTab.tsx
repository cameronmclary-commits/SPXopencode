import { useState, useEffect, useMemo } from 'react'
import type { SessionInfo, ChainSnapshot } from '../types'
import { findBestCombo } from '../utils/combos'
import { comboCostHistory, rollingZscore, comboAskCost, comboBidValue } from '../utils/signals'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts'

interface Props {
  sessions: SessionInfo[]
}

interface MarkoutCurve {
  threshold: number
  label: string
  color: string
  entries: number
  curve: { step: number; markout: number }[]
  stats: { avgProfit: number; winRate: number; maxProfit: number; maxLoss: number }
}

const THRESHOLDS = [
  { value: 0.5, label: '-0.5σ', color: '#fbbf24' },
  { value: 1.0, label: '-1.0σ', color: '#22c55e' },
  { value: 1.5, label: '-1.5σ', color: '#06b6d4' },
  { value: 2.0, label: '-2.0σ', color: '#a855f7' },
]

export default function MarkoutTab({ sessions }: Props) {
  const [selectedDate, setSelectedDate] = useState(sessions[0]?.date || '')
  const [snapshots, setSnapshots] = useState<ChainSnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [maxHold, setMaxHold] = useState(5)
  const [minCostFilter, setMinCostFilter] = useState(10)
  const [maxCostFilter, setMaxCostFilter] = useState(90)
  const [lookback, setLookback] = useState(25)

  useEffect(() => {
    if (!selectedDate) return
    setLoading(true)
    fetch(`/api/sessions/${selectedDate}/snapshots`)
      .then(r => r.json())
      .then(data => {
        setSnapshots(data.snapshots || [])
      })
      .catch(() => setSnapshots([]))
      .finally(() => setLoading(false))
  }, [selectedDate])

  const scanParams = useMemo(() => ({
    maxCost: maxCostFilter, templateMove: 25, minPnl10: 1, minPnl: 0,
    minPnlHalf: 0, minSideDelta: 0.4, minBalance: 0.6, minGap: 5,
    minSpotGap: 2, maxStep: 10,
  }), [maxCostFilter])

  const bestCombo = useMemo(() => {
    if (snapshots.length === 0) return null
    const first = snapshots[0]
    const results = findBestCombo(
      first.chain, first.spot,
      scanParams.maxCost, scanParams.templateMove, scanParams.minPnl10,
      scanParams.minPnl, scanParams.minPnlHalf, scanParams.minSideDelta,
      scanParams.minBalance, scanParams.minGap, scanParams.minSpotGap,
      scanParams.maxStep, 1
    )
    if (results.length === 0) return null
    const r = results[0]
    return {
      legs: r.legs.map(l => ({ strike: l.strike, type: l.type, quantity: l.quantity })),
      cost: r.cost,
    }
  }, [snapshots, scanParams])

  const costHistory = useMemo(() => {
    if (!bestCombo) return []
    return comboCostHistory(bestCombo.legs, snapshots)
  }, [bestCombo, snapshots])

  const zscores = useMemo(() => {
    if (costHistory.length < lookback + 1) return []
    return rollingZscore(costHistory.map(c => c.cost), lookback)
  }, [costHistory, lookback])

  const curves = useMemo<MarkoutCurve[]>(() => {
    if (!bestCombo || zscores.length < 10) return []
    const z = zscores
    const maxStep = maxHold

    return THRESHOLDS.map(t => {
      const entries: number[] = []
      for (let i = 1; i < z.length; i++) {
        if (z[i] != null && z[i]! <= -t.value) {
          const prev = z[i - 1]
          if (prev == null || prev > -t.value) {
            entries.push(i)
          }
        }
      }

      const allMarkouts: number[][] = entries.map(entryIdx => {
        const entryCost = costHistory[entryIdx].cost
        if (entryCost < minCostFilter) return []
            const row: number[] = [0]
            for (let j = 1; j <= maxStep && entryIdx + j < snapshots.length; j++) {
              const cur = comboBidValue(bestCombo.legs, snapshots[entryIdx + j])
              row.push(cur - entryCost)
            }
        return row.filter((_, k) => k <= maxStep)
      }).filter(r => r.length > 1)

      if (allMarkouts.length === 0) {
        return { threshold: t.value, label: t.label, color: t.color, entries: 0, curve: [], stats: { avgProfit: 0, winRate: 0, maxProfit: 0, maxLoss: 0 } }
      }

      const maxLen = Math.max(...allMarkouts.map(m => m.length))
      const curve: { step: number; markout: number }[] = []
      for (let i = 0; i < maxLen; i++) {
        const vals = allMarkouts.filter(m => m.length > i).map(m => m[i])
        const avg = vals.reduce((s, v) => s + v, 0) / vals.length
        curve.push({ step: i, markout: Math.round(avg * 100) / 100 })
      }

      const finalVals = allMarkouts.map(m => m[m.length - 1])
      const avgProfit = finalVals.reduce((s, v) => s + v, 0) / finalVals.length
      const winRate = finalVals.filter(v => v > 0).length / finalVals.length
      const maxProfit = Math.max(...finalVals)
      const maxLoss = Math.min(...finalVals)

      return {
        threshold: t.value, label: t.label, color: t.color,
        entries: allMarkouts.length,
        curve,
        stats: {
          avgProfit: Math.round(avgProfit * 100) / 100,
          winRate: Math.round(winRate * 100),
          maxProfit: Math.round(maxProfit * 100) / 100,
          maxLoss: Math.round(maxLoss * 100) / 100,
        },
      }
    }).filter(c => c.entries > 0)
  }, [bestCombo, costHistory, zscores, snapshots, maxHold, minCostFilter])

  const chartData = useMemo(() => {
    if (curves.length === 0) return []
    const maxLen = Math.max(...curves.map(c => c.curve.length))
    const result: any[] = []
    for (let i = 0; i < maxLen; i++) {
      const row: any = { step: i }
      for (const c of curves) {
        row[c.label] = c.curve[i]?.markout ?? null
      }
      result.push(row)
    }
    return result
  }, [curves])

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="panel-bg border border-zborder rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-ztextdim tracking-wide">Markout Analysis</h3>
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
          <div className="text-xs text-ztextdim py-4 text-center">No snapshots available for this session.</div>
        )}

        {snapshots.length > 0 && !bestCombo && (
          <div className="text-xs text-ztextdim py-4 text-center">No valid combo structure found at open. Try adjusting scanner params.</div>
        )}

        {bestCombo && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="panel-bg border border-zborder rounded-lg p-3">
                <div className="text-[10px] text-ztextdim tracking-wide uppercase">Combo Cost</div>
                <div className="text-lg font-semibold font-mono text-white">${bestCombo.cost.toFixed(2)}</div>
              </div>
              <div className="panel-bg border border-zborder rounded-lg p-3">
                <div className="text-[10px] text-ztextdim tracking-wide uppercase">Snapshots</div>
                <div className="text-lg font-semibold font-mono text-white">{snapshots.length}</div>
              </div>
              <div className="panel-bg border border-zborder rounded-lg p-3">
                <div className="text-[10px] text-ztextdim tracking-wide uppercase">Cost Range</div>
                <div className="text-lg font-semibold font-mono text-white">
                  ${Math.min(...costHistory.map(c => c.cost)).toFixed(2)} – ${Math.max(...costHistory.map(c => c.cost)).toFixed(2)}
                </div>
              </div>
              <div className="panel-bg border border-zborder rounded-lg p-3">
                <div className="text-[10px] text-ztextdim tracking-wide uppercase">Total Entries</div>
                <div className="text-lg font-semibold font-mono text-white">
                  {curves.reduce((s, c) => s + c.entries, 0)}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4 mb-3 text-xs">
              <div className="flex items-center gap-1">
                <label className="text-ztextdim">Max Cost:</label>
                <input type="number" value={maxCostFilter} onChange={e => setMaxCostFilter(Number(e.target.value))}
                  className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" />
              </div>
              <div className="flex items-center gap-1">
                <label className="text-ztextdim">Min Cost:</label>
                <input type="number" value={minCostFilter} onChange={e => setMinCostFilter(Number(e.target.value))}
                  className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" />
              </div>
              <div className="flex items-center gap-1">
                <label className="text-ztextdim">Lookback:</label>
                <input type="number" value={lookback} onChange={e => setLookback(Math.max(3, Number(e.target.value)))}
                  className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" />
              </div>
              <div className="flex items-center gap-1">
                <label className="text-ztextdim">Max Hold:</label>
                <input type="number" value={maxHold} onChange={e => setMaxHold(Math.max(1, Number(e.target.value)))}
                  className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-16" />
              </div>
            </div>

            <div className="mb-2 text-[10px] text-ztextdim font-mono">
              Combo: {bestCombo.legs.map(l => `${l.type === 'call' ? 'C' : 'P'} ${l.strike}×${l.quantity}`).join(' ')}
            </div>

            {chartData.length > 0 && (
              <div className="h-72 mb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 5 }}>
                    <XAxis dataKey="step" tick={{ fontSize: 10, fill: '#6b7280' }} />
                    <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={v => `$${v.toFixed(1)}`} />
                    <Tooltip
                      contentStyle={{ background: '#1a1a2e', border: '1px solid #2d2d4a', borderRadius: '8px', fontSize: '12px' }}
                      formatter={(v: number) => [`$${v.toFixed(2)}`, 'Markout']}
                    />
                    <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="4 4" />
                    {curves.map(c => (
                      <Line key={c.label} type="stepAfter" dataKey={c.label} stroke={c.color} strokeWidth={2} dot={false} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {curves.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-ztextdim border-b border-zborder">
                      <th className="text-left px-2 py-1 font-medium">Threshold</th>
                      <th className="text-right px-2 py-1 font-medium">Entries</th>
                      <th className="text-right px-2 py-1 font-medium">Avg Profit</th>
                      <th className="text-right px-2 py-1 font-medium">Win Rate</th>
                      <th className="text-right px-2 py-1 font-medium">Max</th>
                      <th className="text-right px-2 py-1 font-medium">Min</th>
                    </tr>
                  </thead>
                  <tbody>
                    {curves.map(c => (
                      <tr key={c.label} className="border-b border-zborder/30 hover:bg-zgray/20">
                        <td className="px-2 py-1 font-mono" style={{ color: c.color }}>{c.label}</td>
                        <td className="text-right px-2 py-1 font-mono">{c.entries}</td>
                        <td className={`text-right px-2 py-1 font-mono ${c.stats.avgProfit >= 0 ? 'text-zgreen' : 'text-zred'}`}>
                          ${c.stats.avgProfit.toFixed(2)}
                        </td>
                        <td className={`text-right px-2 py-1 font-mono ${c.stats.winRate >= 50 ? 'text-zgreen' : 'text-zred'}`}>
                          {c.stats.winRate}%
                        </td>
                        <td className="text-right px-2 py-1 font-mono text-zgreen">${c.stats.maxProfit.toFixed(2)}</td>
                        <td className="text-right px-2 py-1 font-mono text-zred">${c.stats.maxLoss.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {curves.length === 0 && bestCombo && (
              <div className="text-xs text-ztextdim py-4 text-center">No z-score entries found. Try a different lookback or cost threshold.</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
