import { useState, useEffect } from 'react'
import type { OptionRow } from '../types'
import { fetchChain } from '../api'

interface Props {
  date: string
}

export default function ChainTab({ date }: Props) {
  const [chain, setChain] = useState<OptionRow[]>([])
  const [spot, setSpot] = useState(0)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'calls' | 'puts'>('all')
  const [sortBy, setSortBy] = useState<'strike' | 'volume'>('strike')

  useEffect(() => {
    if (!date) return
    setLoading(true)
    fetchChain(date)
      .then(res => {
        setChain(res.chain)
        setSpot(res.spotPrice)
      })
      .catch(() => setChain([]))
      .finally(() => setLoading(false))
  }, [date])

  const filtered = chain.filter(r => {
    if (filter === 'calls') return r.type === 'call'
    if (filter === 'puts') return r.type === 'put'
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'volume') return b.volume - a.volume
    return a.strike - b.strike
  })

  const calls = sorted.filter(r => r.type === 'call')
  const puts = sorted.filter(r => r.type === 'put')

  if (loading) return <div className="text-center py-12 text-ztextdim animate-pulse">Loading chain...</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-2">
          {(['all', 'calls', 'puts'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-full border ${
                filter === f ? 'border-zcyan text-zcyan bg-zcyan/10' : 'border-zborder text-ztextdim hover:text-ztext'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as typeof sortBy)}
          className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext"
        >
          <option value="strike">Sort by Strike</option>
          <option value="volume">Sort by Volume</option>
        </select>
      </div>

      <div className="flex gap-2">
        <span className="text-xs text-ztextdim">Spot:</span>
        <span className="text-xs text-white font-mono">${spot.toFixed(2)}</span>
        <span className="text-xs text-ztextdim">OTM Calls:</span>
        <span className="text-xs text-zgreen font-mono">{calls.filter(r => r.strike > spot).length}</span>
        <span className="text-xs text-ztextdim">OTM Puts:</span>
        <span className="text-xs text-zred font-mono">{puts.filter(r => r.strike < spot).length}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChainTable title="CALLS" rows={calls} spot={spot} color="text-zgreen" />
        <ChainTable title="PUTS" rows={puts} spot={spot} color="text-zred" />
      </div>
    </div>
  )
}

function ChainTable({ title, rows, spot, color }: { title: string; rows: OptionRow[]; spot: number; color: string }) {
  return (
    <div className="bg-zgray/30 border border-zborder rounded-lg overflow-hidden">
      <div className={`px-4 py-2 text-xs font-semibold ${color} border-b border-zborder`}>
        {title} ({rows.length})
      </div>
      <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zdark/95 backdrop-blur-sm">
            <tr className="text-ztextdim border-b border-zborder">
              <th className="text-left px-3 py-2 font-medium">Strike</th>
              <th className="text-right px-3 py-2 font-medium">Bid</th>
              <th className="text-right px-3 py-2 font-medium">Ask</th>
              <th className="text-right px-3 py-2 font-medium">Mid</th>
              <th className="text-right px-3 py-2 font-medium">Vol</th>
              <th className="text-right px-3 py-2 font-medium">OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const itm = r.strike > spot
              return (
                <tr key={`${r.strike}-${r.type}`} className="border-b border-zborder/50 hover:bg-zgray/20 transition-colors">
                  <td className={`px-3 py-1.5 font-mono font-medium ${itm ? 'text-zgreen' : 'text-zred'}`}>
                    {r.strike.toFixed(0)}
                  </td>
                  <td className="text-right px-3 py-1.5 font-mono">{r.bid.toFixed(2)}</td>
                  <td className="text-right px-3 py-1.5 font-mono">{r.ask.toFixed(2)}</td>
                  <td className="text-right px-3 py-1.5 font-mono">{r.mid.toFixed(2)}</td>
                  <td className="text-right px-3 py-1.5 font-mono">{r.volume.toLocaleString()}</td>
                  <td className="text-right px-3 py-1.5 font-mono">{r.openInterest.toLocaleString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
