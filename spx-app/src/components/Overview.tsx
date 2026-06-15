import { useState, useEffect, useRef } from 'react'
import type { SessionData, OptionRow, ChainSnapshot } from '../types'
import { XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart, BarChart, Bar } from 'recharts'

interface Props {
  data: SessionData | null
  loading: boolean
}

function findATM(chain: OptionRow[], spot: number) {
  const calls = chain.filter(r => r.type === 'call').sort((a, b) => a.strike - b.strike)
  const puts = chain.filter(r => r.type === 'put').sort((a, b) => a.strike - b.strike)
  const atmCall = calls.reduce((best, r) => Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best)
  const atmPut = puts.reduce((best, r) => Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best)
  return { atmCall, atmPut }
}

function avgSpread(chain: OptionRow[], spot: number, n: number): number {
  const sorted = [...chain].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, n)
  if (sorted.length === 0) return 0
  return sorted.reduce((s, r) => s + (r.ask - r.bid), 0) / sorted.length
}

function totalOI(chain: OptionRow[]): { calls: number; puts: number } {
  return {
    calls: chain.filter(r => r.type === 'call').reduce((s, r) => s + r.openInterest, 0),
    puts: chain.filter(r => r.type === 'put').reduce((s, r) => s + r.openInterest, 0),
  }
}

function findATMInSnapshot(snapshot: ChainSnapshot): { callMid: number; putMid: number; straddle: number } {
  const calls = snapshot.chain.filter(r => r.type === 'call')
  const puts = snapshot.chain.filter(r => r.type === 'put')
  const spot = snapshot.spot
  if (!calls.length || !puts.length) return { callMid: 0, putMid: 0, straddle: 0 }
  const atmCall = calls.reduce((best, r) => Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best)
  const atmPut = puts.reduce((best, r) => Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best)
  const callMid = atmCall?.mid ?? 0
  const putMid = atmPut?.mid ?? 0
  return { callMid, putMid, straddle: callMid + putMid }
}

export default function Overview({ data, loading }: Props) {
  const [liveSpot, setLiveSpot] = useState(0)
  const [liveChain, setLiveChain] = useState<OptionRow[]>([])
  const [ibkrStatus, setIbkrStatus] = useState<'offline' | 'connected' | 'authenticated'>('offline')
  const [snapshots, setSnapshots] = useState<ChainSnapshot[]>([])
  const liveApiBase = window.location.origin
  const polledRef = useRef(false)

  useEffect(() => {
    if (polledRef.current) return
    polledRef.current = true
    const poll = async () => {
      try {
        const r = await fetch(liveApiBase + '/api/live/status')
        if (r.ok) {
          const s = await r.json()
          setIbkrStatus(s.authenticated ? 'authenticated' : s.connected ? 'connected' : 'offline')
          if (s.spot > 0) setLiveSpot(s.spot)
          if (s.active) {
            const [cr, sr] = await Promise.all([
              fetch(liveApiBase + '/api/live/chain'),
              fetch(liveApiBase + '/api/live/spot'),
            ])
            if (cr.ok) { const d = await cr.json(); if (d.chain?.length) setLiveChain(d.chain) }
            if (sr.ok) { const d = await sr.json(); if (d.spot > 0) setLiveSpot(d.spot) }
          }
        }
      } catch (e) { console.warn('Failed to fetch live data:', e) }
    }
    poll()
    const iv = setInterval(poll, 10000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    if (!data?.date) { setSnapshots([]); return }
    fetch(`/api/sessions/${data.date}/snapshots`)
      .then(r => r.json())
      .then(d => setSnapshots(d.snapshots || []))
      .catch(() => setSnapshots([]))
  }, [data?.date])

  if (loading) {
    return (
      <div className="panel-bg border border-zborder rounded-lg p-12 text-center animate-fade-in">
        <div className="text-ztextdim animate-pulse">Loading session data...</div>
      </div>
    )
  }

  const hasLive = ibkrStatus === 'authenticated' && liveChain.length > 0
  const displaySpot = hasLive ? liveSpot : data?.spotPrice || 0
  const displayChain = hasLive ? liveChain : data?.openingChain || []

  if (!data && !hasLive) {
    return (
      <div className="panel-bg border border-zborder rounded-lg p-12 text-center animate-fade-in">
        <p className="text-ztextdim">No session data available.</p>
        <p className="text-xs mt-2 text-ztextdim">Select a date from the dropdown{ibkrStatus === 'connected' ? ', or start IB Gateway and authenticate' : ''}.</p>
      </div>
    )
  }

  const { spotPrice, pricePath, dailyLow, dailyHigh, dailyChange } = data || { spotPrice: liveSpot, pricePath: [], dailyLow: liveSpot, dailyHigh: liveSpot, dailyChange: 0 }
  const openingChain = displayChain

  const chainPath = pricePath.map((p, i) => {
    const snap = snapshots[i]
    if (snap) {
      const { callMid, putMid, straddle } = findATMInSnapshot(snap)
      return { ...p, callMid, putMid, straddle }
    }
    return { ...p, callMid: 0, putMid: 0, straddle: 0 }
  })

  const { atmCall, atmPut } = findATM(openingChain, displaySpot)
  const spread = avgSpread(openingChain, displaySpot, 5)
  const oi = totalOI(openingChain)
  const straddle = atmCall.mid + atmPut.mid

  return (
    <div className="space-y-4 animate-fade-in">
      {hasLive && (
        <div className="panel-bg border border-zgreen/40 rounded-lg p-3 flex items-center gap-3 animate-fade-in" style={{ boxShadow: '0 0 16px rgba(34,197,94,0.08)' }}>
          <span className="w-2 h-2 rounded-full bg-zgreen animate-pulse-glow" />
          <span className="text-xs text-zgreen font-medium tracking-wide">LIVE</span>
          <span className="text-xs text-ztextdim font-mono">SPX {liveSpot.toFixed(2)}</span>
          <span className="text-xs text-ztextdim font-mono">{liveChain.length} strikes</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label={hasLive ? 'Current' : 'Close'} value={displaySpot.toFixed(2)} />
        <StatCard label="High" value={dailyHigh.toFixed(2)} change={dailyHigh > spotPrice} />
        <StatCard label="Low" value={dailyLow.toFixed(2)} change={dailyLow < spotPrice} />
        <StatCard label="Day Chg" value={`${dailyChange >= 0 ? '+' : ''}${dailyChange.toFixed(2)}`} change={dailyChange >= 0} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Range" value={`${(dailyHigh - dailyLow).toFixed(1)} pts`} />
        <StatCard label="Move %" value={`${(dailyChange / (spotPrice - dailyChange) * 100).toFixed(2)}%`} change={dailyChange >= 0} />
        <StatCard label="ATM Call" value={atmCall.mid.toFixed(2)} subtitle={hasLive ? `${atmCall.strike.toFixed(0)} strike (live)` : `${atmCall.strike.toFixed(0)} strike`} />
        <StatCard label="ATM Put" value={atmPut.mid.toFixed(2)} subtitle={hasLive ? `${atmPut.strike.toFixed(0)} strike (live)` : `${atmPut.strike.toFixed(0)} strike`} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="ATM Straddle" value={straddle.toFixed(2)} />
        <StatCard label="Avg Spread (5)" value={spread.toFixed(2)} subtitle="near-the-money" />
        <StatCard label="Calls OI" value={oi.calls.toLocaleString()} />
        <StatCard label="Puts OI" value={oi.puts.toLocaleString()} />
      </div>

      {chainPath.length > 0 && (
        <div className="panel-bg border border-zborder rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-ztextdim tracking-wide">Intraday Price & ATM Straddle Decay</h3>
            <span className="text-[10px] text-ztextdim tracking-wide uppercase">real chain — 0DTE straddle approaches zero at expiration</span>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={chainPath}>
              <defs>
                <linearGradient id="pxGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="straddleGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a855f7" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#a855f7" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#6b7280' }} interval={5} />
              <YAxis yAxisId="price" domain={['dataMin', 'dataMax']} tick={{ fontSize: 10, fill: '#6b7280' }} padding={{ top: 20, bottom: 20 }} />
              <YAxis yAxisId="opt" orientation="right" domain={[0, 'dataMax']} tick={{ fontSize: 10, fill: '#6b7280' }} padding={{ top: 20, bottom: 0 }} />
              <Tooltip
                contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#c4c4d4', fontWeight: 600 }}
              />
              <Area yAxisId="price" type="monotone" dataKey="price" stroke="#06b6d4" fill="url(#pxGrad)" strokeWidth={2} />
              <Area yAxisId="opt" type="monotone" dataKey="straddle" stroke="#a855f7" fill="url(#straddleGrad)" strokeWidth={1.5} strokeDasharray="4 3" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="panel-bg border border-zborder rounded-lg p-4">
          <h3 className="text-sm font-medium text-ztextdim tracking-wide mb-3">Chain Overview {hasLive && <span className="text-zgreen text-[10px]">(live)</span>}</h3>
          <div className="space-y-2 text-xs">
            <Row label="Total Strikes" value={openingChain.length.toString()} />
            <Row label="Calls" value={openingChain.filter(r => r.type === 'call').length.toString()} color="text-zgreen" />
            <Row label="Puts" value={openingChain.filter(r => r.type === 'put').length.toString()} color="text-zred" />
            <Row label="Put/Call OI Ratio" value={`${(oi.puts / (oi.calls || 1)).toFixed(2)}x`} />
            <Row label="ATM Strike (Call)" value={atmCall.strike.toFixed(0)} />
            <Row label="ATM Strike (Put)" value={atmPut.strike.toFixed(0)} />
            <Row label="ATM Spread" value={`${(atmCall.ask - atmCall.bid).toFixed(2)} / ${(atmPut.ask - atmPut.bid).toFixed(2)}`} />
            <Row label="Strikes ±1%" value={openingChain.filter(r => Math.abs(r.strike - displaySpot) / displaySpot < 0.01).length.toString()} />
          </div>
        </div>

        <div className="panel-bg border border-zborder rounded-lg p-4">
          <h3 className="text-sm font-medium text-ztextdim tracking-wide mb-3">Strike Distribution</h3>
          {(() => {
            const step = 5
            const bins: { name: string; calls: number; puts: number }[] = []
            const minK = Math.floor(displaySpot / step - 20) * step
            const maxK = Math.ceil(displaySpot / step + 20) * step
            for (let k = minK; k <= maxK; k += step) {
              bins.push({
                name: `${k}`,
                calls: openingChain.filter(r => r.type === 'call' && r.strike === k).length,
                puts: openingChain.filter(r => r.type === 'put' && r.strike === k).length,
              })
            }
            return (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={bins}>
                  <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#6b7280' }} interval={3} />
                  <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} />
                  <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 6, fontSize: 11 }} />
                  <Bar dataKey="calls" fill="#22c55e" radius={[2, 2, 0, 0]} opacity={0.7} />
                  <Bar dataKey="puts" fill="#ef4444" radius={[2, 2, 0, 0]} opacity={0.7} />
                </BarChart>
              </ResponsiveContainer>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, change, subtitle }: { label: string; value: string; change?: boolean | string; subtitle?: string }) {
  const isUp = change === true || (typeof change === 'string' && parseFloat(change) >= 0)
  const isDown = change === false || (typeof change === 'string' && parseFloat(change) < 0)
  return (
    <div className="panel-bg border border-zborder rounded-lg p-3">
      <div className="text-[10px] text-ztextdim tracking-wide uppercase mb-0.5">{label}</div>
      <div className={`text-lg font-semibold font-mono ${isUp ? 'text-zgreen' : isDown ? 'text-zred' : 'text-white'}`}>
        {value}
      </div>
      {subtitle && <div className="text-[10px] text-ztextdim mt-0.5">{subtitle}</div>}
    </div>
  )
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between py-1 border-b border-zborder/30 last:border-0">
      <span className="text-ztextdim">{label}</span>
      <span className={`font-mono ${color || 'text-white'}`}>{value}</span>
    </div>
  )
}
