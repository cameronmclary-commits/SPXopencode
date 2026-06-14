import { useState, useEffect } from 'react'
import { fetchSessions, fetchSession } from '../api'
import type { SessionInfo, SessionData } from '../types'

export default function PreMarket() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [lastSession, setLastSession] = useState<SessionData | null>(null)

  useEffect(() => {
    fetchSessions().then(s => {
      setSessions(s)
      if (s.length > 0) {
        fetchSession(s[s.length - 1].date).then(setLastSession).catch(() => {})
      }
    }).catch(() => {})
  }, [])

  const prevClose = lastSession?.dailyClose || 0
  const futures = prevClose * 1.002
  const futuresChange = futures - prevClose
  const futuresPct = (futuresChange / prevClose) * 100

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
          <div className="text-xs text-ztextdim mb-1">Previous Close</div>
          <div className="text-xl font-semibold text-white font-mono">${prevClose.toFixed(2)}</div>
        </div>
        <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
          <div className="text-xs text-ztextdim mb-1">ES Futures (est.)</div>
          <div className="text-xl font-semibold text-white font-mono">${futures.toFixed(2)}</div>
          <div className={`text-xs mt-1 font-mono ${futuresChange >= 0 ? 'text-zgreen' : 'text-zred'}`}>
            {futuresChange >= 0 ? '+' : ''}{futuresChange.toFixed(2)} ({futuresChange >= 0 ? '+' : ''}{futuresPct.toFixed(2)}%)
          </div>
        </div>
        <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
          <div className="text-xs text-ztextdim mb-1">Sessions Available</div>
          <div className="text-xl font-semibold text-white font-mono">{sessions.length}</div>
        </div>
      </div>

      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Pre-Market Notes</h3>
        <ul className="space-y-2 text-sm text-ztext">
          <li className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-zcyan" />
            Session data is historical — no live pre-market feed.
          </li>
          <li className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-zcyan" />
            Futures estimate based on +0.2% from prior close (placeholder).
          </li>
          <li className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-zcyan" />
            Connect to a live MCP server for real-time pre-market data.
          </li>
        </ul>
      </div>
    </div>
  )
}
