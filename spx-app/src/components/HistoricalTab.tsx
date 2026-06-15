import { useState, useEffect } from 'react'
import type { SessionInfo, SessionData } from '../types'
import { fetchSession } from '../api'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

interface Props {
  sessions: SessionInfo[]
}

const RECENT = 20

export default function HistoricalTab({ sessions }: Props) {
  const [sessionData, setSessionData] = useState<SessionData[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const recent = sessions.slice(-RECENT)
    setLoading(true)
    Promise.all(recent.map(s => fetchSession(s.date).catch(() => null)))
      .then(results => setSessionData(results.filter((d): d is SessionData => d !== null)))
      .finally(() => setLoading(false))
  }, [sessions])

  const sorted = [...sessionData].sort((a, b) => a.date.localeCompare(b.date))

  const dailyData = sorted.map(d => ({
    date: d.date.slice(5),
    open: d.spotPrice,
    high: d.dailyHigh,
    low: d.dailyLow,
    close: d.dailyClose,
    range: d.dailyHigh - d.dailyLow,
  }))

  if (loading) return <div className="text-center py-12 text-ztextdim animate-pulse">Loading historical data...</div>
  if (dailyData.length === 0) return <div className="text-center py-12 text-ztextdim">No historical data.</div>

  return (
    <div className="space-y-6">
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Daily Close Prices</h3>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={dailyData}>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} />
            <YAxis domain={['dataMin', 'dataMax']} tick={{ fontSize: 10, fill: '#6b7280' }} padding={{ top: 20, bottom: 20 }} />
            <Tooltip
              contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 8, fontSize: 12 }}
            />
            <Line type="monotone" dataKey="close" stroke="#06b6d4" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Daily Range (High - Low)</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={dailyData}>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} />
            <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
            <Tooltip
              contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 8, fontSize: 12 }}
            />
            <Line type="monotone" dataKey="range" stroke="#a855f7" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-zgray/30 border border-zborder rounded-lg overflow-hidden">
        <div className="px-4 py-2 text-xs font-semibold text-ztextdim border-b border-zborder">
          Daily Summary
        </div>
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-zdark/95 backdrop-blur-sm">
              <tr className="text-ztextdim border-b border-zborder">
                <th className="text-left px-3 py-2 font-medium">Date</th>
                <th className="text-right px-3 py-2 font-medium">Open</th>
                <th className="text-right px-3 py-2 font-medium">High</th>
                <th className="text-right px-3 py-2 font-medium">Low</th>
                <th className="text-right px-3 py-2 font-medium">Close</th>
                <th className="text-right px-3 py-2 font-medium">Range</th>
              </tr>
            </thead>
            <tbody>
              {dailyData.map(d => (
                <tr key={d.date} className="border-b border-zborder/50 hover:bg-zgray/20 transition-colors">
                  <td className="px-3 py-1.5 font-mono text-ztext">{d.date}</td>
                  <td className="text-right px-3 py-1.5 font-mono">{d.open.toFixed(2)}</td>
                  <td className="text-right px-3 py-1.5 font-mono text-zgreen">{d.high.toFixed(2)}</td>
                  <td className="text-right px-3 py-1.5 font-mono text-zred">{d.low.toFixed(2)}</td>
                  <td className={`text-right px-3 py-1.5 font-mono ${d.close >= d.open ? 'text-zgreen' : 'text-zred'}`}>
                    {d.close.toFixed(2)}
                  </td>
                  <td className="text-right px-3 py-1.5 font-mono text-zpurple">{d.range.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
