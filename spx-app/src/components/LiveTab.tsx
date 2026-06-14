import { useState, useEffect, useRef, useCallback } from 'react'
import type { OptionRow } from '../types'
import TradeScanner from './TradeScanner'

interface LiveStatus {
  connected: boolean
  authenticated: boolean
  active: boolean
  chainSize: number
  spot: number
}

interface LiveChain {
  date: string
  spotPrice: number
  chainSize: number
  chain: OptionRow[]
}

interface PricePoint {
  time: string
  price: number
}

function timeInRange(t: string, start: string, end: string): boolean {
  return t >= start && t <= end
}

export default function LiveTab() {
  const [status, setStatus] = useState<LiveStatus | null>(null)
  const [chain, setChain] = useState<LiveChain | null>(null)
  const [spot, setSpot] = useState(0)
  const [pricePath, setPricePath] = useState<PricePoint[]>([])
  const [uptime, setUptime] = useState(0)
  const [error, setError] = useState('')
  const [pollCount, setPollCount] = useState(0)
  const [sessionStart, setSessionStart] = useState('09:30')
  const [sessionEnd, setSessionEnd] = useState('16:00')
  const pollingRef = useRef(false)

  const now = new Date()
  const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const inSession = timeInRange(currentHHMM, sessionStart, sessionEnd)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/live/status')
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
        if (data.spot > 0) setSpot(data.spot)
        setError('')
      }
    } catch { }
  }, [])

  const fetchChain = useCallback(async () => {
    try {
      const res = await fetch('/api/live/chain')
      if (res.ok) {
        const data = await res.json()
        if (data.chain?.length > 0) {
          setChain(data)
          setSpot(data.spotPrice)
        }
      }
    } catch { }
  }, [])

  const fetchSpot = useCallback(async () => {
    try {
      const res = await fetch('/api/live/spot')
      if (res.ok) {
        const data = await res.json()
        if (data.spot > 0) setSpot(data.spot)
        if (data.pricePath?.length > 0) {
          setPricePath(data.pricePath)
        }
        setUptime(data.uptime || 0)
      }
    } catch { }
  }, [])

  useEffect(() => {
    const poll = async () => {
      if (pollingRef.current) return
      pollingRef.current = true
      await fetchStatus()
      if (status?.active) {
        setPollCount(c => c + 1)
        if (pollCount % 4 === 0) await fetchChain()
        await fetchSpot()
      }
      pollingRef.current = false
    }

    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [fetchStatus, fetchChain, fetchSpot, status?.active, pollCount])

  if (!status) {
    return (
      <div className="bg-zgray/30 border border-zborder rounded-lg p-8 text-center">
        <div className="text-ztextdim text-sm animate-pulse">Connecting to IB Gateway...</div>
        <div className="mt-2 text-xs text-ztextdim">
          Make sure TWS or IB Gateway is running on port 5000 with API connections enabled.
        </div>
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="bg-zgray/30 border border-zborder rounded-lg p-8 text-center">
        <div className="text-zred text-sm font-medium mb-2">IB Gateway Not Reachable</div>
        <div className="text-xs text-ztextdim">
          Start TWS or IB Gateway on port 5000 (Client Portal API) and log in.
          <br />Enable API connections in Configuration → API → Enable/Trusted IPs (add 127.0.0.1).
        </div>
        <button onClick={fetchStatus}
          className="mt-4 px-3 py-1 text-xs rounded bg-zcyan/20 text-zcyan border border-zcyan hover:bg-zcyan/30">
          Retry
        </button>
      </div>
    )
  }

  if (!status.authenticated) {
    return (
      <div className="bg-zgray/30 border border-zborder rounded-lg p-8 text-center">
        <div className="text-zyellow text-sm font-medium mb-2">Not Authenticated</div>
        <div className="text-xs text-ztextdim">Log in to TWS or IB Gateway to enable API access.</div>
        <button onClick={fetchStatus}
          className="mt-4 px-3 py-1 text-xs rounded bg-zcyan/20 text-zcyan border border-zcyan hover:bg-zcyan/30">
          Retry
        </button>
      </div>
    )
  }

  const change = pricePath.length > 1 ? (spot - pricePath[0].price) : 0
  const changePct = pricePath.length > 1 && pricePath[0].price > 0 ? (change / pricePath[0].price) * 100 : 0
  const minutes = Math.floor(uptime / 60000)

  return (
    <div className="space-y-4">
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-ztextdim">Live Trading — IBKR Paper</h3>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-zgreen animate-pulse" />
            <span className="text-xs text-zgreen">LIVE</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-6">
          <div>
            <div className="text-xs text-ztextdim">SPX</div>
            <div className="text-2xl font-bold font-mono text-white">{spot.toFixed(2)}</div>
            <div className={`text-xs font-mono ${change >= 0 ? 'text-zgreen' : 'text-zred'}`}>
              {change >= 0 ? '+' : ''}{change.toFixed(2)} ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
            </div>
          </div>
          <div>
            <div className="text-xs text-ztextdim">Session</div>
            <div className="text-sm font-mono text-white">{minutes}m</div>
          </div>
          <div>
            <div className="text-xs text-ztextdim">Chain</div>
            <div className="text-sm font-mono text-white">{chain?.chainSize || status.chainSize || 0} strikes</div>
            {chain && <div className="text-xs text-ztextdim">Updated {new Date().toLocaleTimeString()}</div>}
          </div>
          <div>
            <div className="text-xs text-ztextdim">Price Path</div>
            <div className="text-sm font-mono text-white">{pricePath.length} pts</div>
          </div>
        </div>

        {error && <div className="mt-2 text-xs text-zred">{error}</div>}

        <div className="flex flex-wrap gap-4 mt-4 pt-3 border-t border-zborder">
          <div>
            <label className="text-xs text-ztextdim">Session Start</label>
            <input type="time" value={sessionStart} onChange={e => setSessionStart(e.target.value)} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext" />
          </div>
          <div>
            <label className="text-xs text-ztextdim">Session End</label>
            <input type="time" value={sessionEnd} onChange={e => setSessionEnd(e.target.value)} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext" />
          </div>
          <div className="flex items-center">
            <span className={`text-xs ${inSession ? 'text-zgreen' : 'text-ztextdim'}`}>
              {inSession ? 'In session hours' : `Outside session hours (${currentHHMM})`}
            </span>
          </div>
        </div>
      </div>

      <TradeScanner
        date={new Date().toISOString().slice(0, 10)}
        chain={chain?.chain || []}
        spotPrice={spot}
      />
    </div>
  )
}
