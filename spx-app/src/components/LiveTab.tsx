import { useState, useEffect, useRef } from 'react'
import type { OptionRow } from '../types'
import { surfacePrice } from '../utils/pricing'
import { ComboLeg, findBestCombo } from '../utils/combos'
import { ParamInput } from './shared/UI'

interface LiveStatus {
  connected: boolean; authenticated: boolean; active: boolean
  chainSize: number; spot: number
}

interface SuggestedTrade {
  id: string
  legs: ComboLeg[]
  totalCost: number; score: number
  pnlPos: number; pnlNeg: number
}

interface OpenTrade {
  id: string; legs: ComboLeg[]; entryCost: number; entrySpot: number
  entryTime: string; pnl: number; pnlPct: number
  entryTp: number; entrySl: number
}

function findSuggestions(chain: OptionRow[], spot: number, maxCost: number, templateMove: number, minPnl: number, minDelta: number): SuggestedTrade[] {
  const results = findBestCombo(chain, spot, maxCost, templateMove, minPnl, minDelta, 10)
  return results.slice(0, 3).map((r, i) => ({
    id: `sug_${i}_${Date.now()}`,
    legs: r.legs,
    totalCost: r.cost,
    score: r.score,
    pnlPos: r.pnlPos,
    pnlNeg: r.pnlNeg,
  }))
}

const TRADES_KEY = 'liveTrades'
const API_KEY = 'liveApiBase'

function loadPersistedTrades(): OpenTrade[] {
  try {
    const raw = localStorage.getItem(TRADES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as OpenTrade[]
    return parsed.map(t => ({ ...t, pnl: 0, pnlPct: 0 }))
  } catch { return [] }
}

function savePersistedTrades(trades: OpenTrade[]) {
  try {
    localStorage.setItem(TRADES_KEY, JSON.stringify(trades))
  } catch {}
}

function loadApiBase(): string {
  try { return localStorage.getItem(API_KEY) || window.location.origin } catch { return window.location.origin }
}

function saveApiBase(url: string) {
  try { localStorage.setItem(API_KEY, url) } catch {}
}

export default function LiveTab() {
  const [status, setStatus] = useState<LiveStatus | null>(null)
  const [chain, setChain] = useState<OptionRow[]>([])
  const [spot, setSpot] = useState(0)
  const [suggestions, setSuggestions] = useState<SuggestedTrade[]>([])
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set())
  const [openTrades, setOpenTrades] = useState<OpenTrade[]>(() => loadPersistedTrades())
  const [accountId, setAccountId] = useState('')
  const [error, setError] = useState('')
  const [placing, setPlacing] = useState<string | null>(null)
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set())

  const [liveApiBase, setLiveApiBase] = useState(() => loadApiBase())

  const [sessionStart, setSessionStart] = useState('09:30')
  const [sessionEnd, setSessionEnd] = useState('16:00')
  const [templateMove, setTemplateMove] = useState(10)
  const [minPnl, setMinPnl] = useState(0)
  const [minDelta, setMinDelta] = useState(0)
  const [maxCost, setMaxCost] = useState(20)
  const [tpPoints, setTpPoints] = useState(3)
  const [slPoints, setSlPoints] = useState(1.5)

  const chainRef = useRef(chain)
  const spotRef = useRef(spot)
  chainRef.current = chain
  spotRef.current = spot

  const openTradesRef = useRef(openTrades)
  openTradesRef.current = openTrades
  const liveApiBaseRef = useRef(liveApiBase)
  liveApiBaseRef.current = liveApiBase

  const stoppedRef = useRef(false)

  useEffect(() => {
    stoppedRef.current = false
    pollLoop()
    return () => { stoppedRef.current = true }
  }, [])

  useEffect(() => { savePersistedTrades(openTrades) }, [openTrades])
  useEffect(() => { saveApiBase(liveApiBase) }, [liveApiBase])

  async function pollLoop() {
    while (!stoppedRef.current) {
      try {
        const base = liveApiBaseRef.current
        const statusRes = await fetch(base + '/api/live/status')
        if (statusRes.ok) {
          const s = await statusRes.json()
          setStatus(s)
          if (s.spot > 0) setSpot(s.spot)

          if (s.active) {
            const [chainRes, spotRes] = await Promise.all([
              fetch(base + '/api/live/chain'),
              fetch(base + '/api/live/spot'),
            ])
            if (chainRes.ok) { const d = await chainRes.json(); if (d.chain?.length) setChain(d.chain) }
            if (spotRes.ok) { const d = await spotRes.json(); if (d.spot > 0) setSpot(d.spot) }

            if (!accountId) {
              const acctRes = await fetch(base + '/api/live/accounts')
              if (acctRes.ok) { const d = await acctRes.json(); if (d.accounts?.[0]) setAccountId(d.accounts[0].id || d.accounts[0].accountId || '') }
            }
          }
        }

        setError('')
      } catch (e) { setError('Connection error') }

      await sleep(5000)
    }
  }

  useEffect(() => {
    if (chain.length === 0 || spot === 0) return
    const all = findSuggestions(chain, spot, maxCost, templateMove, minPnl, minDelta)
    setSuggestions(all.filter(s => !rejectedIds.has(s.id)))
  }, [chain, spot, maxCost, templateMove, minPnl, minDelta, rejectedIds])

  useEffect(() => {
    if (openTrades.length === 0 || chain.length === 0) return
    const interval = setInterval(() => {
      const c = chainRef.current
      const s = spotRef.current
      if (c.length === 0 || s === 0) return

      const idsToClose: string[] = []
      const updated = openTradesRef.current.map(t => {
        const priceShift = s - t.entrySpot
        const val = t.legs.reduce((sum, l) => sum + l.quantity * surfacePrice(c, l.strike, l.type, priceShift, false, s), 0)
        const pnl = val - t.entryCost
        const pnlPct = t.entryCost > 0 ? (pnl / t.entryCost) * 100 : 0

        if (t.entryTp > 0 && pnl >= t.entryTp && !closingIds.has(t.id)) {
          idsToClose.push(t.id)
        }
        if (t.entrySl > 0 && pnl <= -t.entrySl && !closingIds.has(t.id)) {
          idsToClose.push(t.id)
        }

        return { ...t, pnl, pnlPct }
      })

      setOpenTrades(updated)

      if (idsToClose.length > 0) {
        setClosingIds(prev => new Set([...prev, ...idsToClose]))
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [openTrades.length > 0, chain.length > 0])

  useEffect(() => {
    if (closingIds.size === 0) return
    for (const id of closingIds) {
      const trade = openTradesRef.current.find(t => t.id === id)
      if (trade) closeTrade(trade)
    }
  }, [closingIds])

  async function acceptTrade(trade: SuggestedTrade) {
    setPlacing(trade.id)
    if (!accountId) {
      setError('No IBKR account ID available')
      setPlacing(null)
      return
    }
    const results: { ok: boolean; leg: string }[] = []
    for (const leg of trade.legs) {
      if (!leg.conid) { results.push({ ok: false, leg: `${leg.type} ${leg.strike}` }); continue }
      try {
        const res = await fetch(liveApiBaseRef.current + '/api/live/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId, action: 'BUY', quantity: leg.quantity,
            conid: leg.conid, orderType: 'MKT',
          }),
        })
        results.push({ ok: res.ok, leg: `${leg.type} ${leg.strike}` })
      } catch { results.push({ ok: false, leg: `${leg.type} ${leg.strike}` }) }
    }
    setPlacing(null)
    const allOk = results.every(r => r.ok)
    if (!allOk) {
      setError(`Order failed: ${results.filter(r => !r.ok).map(r => r.leg).join(', ')}`)
      return
    }
    const ot: OpenTrade = {
      id: trade.id,
      legs: trade.legs,
      entryCost: trade.totalCost,
      entrySpot: spot,
      entryTime: new Date().toISOString(),
      pnl: 0, pnlPct: 0,
      entryTp: tpPoints, entrySl: slPoints,
    }
    setOpenTrades(prev => [...prev, ot])
    setRejectedIds(prev => new Set([...prev, trade.id]))
  }

  function rejectTrade(id: string) {
    setRejectedIds(prev => new Set([...prev, id]))
    setSuggestions(prev => prev.filter(s => s.id !== id))
  }

  async function closeTrade(trade: OpenTrade) {
    if (!accountId) { setError('No IBKR account ID'); return }
    const results: { ok: boolean; leg: string }[] = []
    for (const leg of trade.legs) {
      if (!leg.conid) continue
      try {
        const res = await fetch(liveApiBaseRef.current + '/api/live/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId, action: 'SELL', quantity: leg.quantity,
            conid: leg.conid, orderType: 'MKT',
          }),
        })
        results.push({ ok: res.ok, leg: `${leg.type} ${leg.strike}` })
      } catch { results.push({ ok: false, leg: `${leg.type} ${leg.strike}` }) }
    }
    const allOk = results.every(r => r.ok)
    if (!allOk) {
      setError(`Close failed: ${results.filter(r => !r.ok).map(r => r.leg).join(', ')}`)
      return
    }
    setOpenTrades(prev => prev.filter(t => t.id !== trade.id))
    setClosingIds(prev => new Set([...prev].filter(id => id !== trade.id)))
  }

  const now = new Date()
  const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const inSession = currentHHMM >= sessionStart && currentHHMM <= sessionEnd

  if (!status) {
    return (
      <div className="panel-bg border border-zborder rounded-lg p-8 text-center animate-fade-in">
        <div className="text-ztextdim text-sm animate-pulse">Connecting to IB Gateway...</div>
        <div className="mt-2 text-xs text-ztextdim">Ensure TWS/IB Gateway is running on port 5000 with API enabled.</div>
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="panel-bg border border-zborder rounded-lg p-8 text-center animate-fade-in">
        <div className="text-zred text-sm font-medium mb-2">IB Gateway Not Reachable</div>
        <div className="text-xs text-ztextdim">Start TWS or IB Gateway on port 5000 and enable API connections.</div>
        <button onClick={() => window.location.reload()} className="mt-4 px-3 py-1 text-xs rounded bg-zcyan/20 text-zcyan border border-zcyan hover:bg-zcyan/30 transition-all duration-200">Retry</button>
      </div>
    )
  }

  if (!status.authenticated) {
    return (
      <div className="panel-bg border border-zborder rounded-lg p-8 text-center animate-fade-in">
        <div className="text-zyellow text-sm font-medium mb-2">Not Authenticated</div>
        <div className="text-xs text-ztextdim">Log in to TWS or IB Gateway.</div>
        <button onClick={() => window.location.reload()} className="mt-4 px-3 py-1 text-xs rounded bg-zcyan/20 text-zcyan border border-zcyan hover:bg-zcyan/30 transition-all duration-200">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="panel-bg border border-zborder rounded-lg p-4 animate-fade-in">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-ztextdim tracking-wide">Live Trading — IBKR Paper</h3>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status.active ? 'bg-zgreen animate-pulse' : 'bg-ztextdim'}`} />
            <span className="text-xs text-zgreen">{status.active ? 'LIVE' : 'Standby'}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-6">
          <div>
            <div className="text-[10px] text-ztextdim tracking-wide uppercase">SPX</div>
            <div className="text-2xl font-bold font-mono text-white">{spot.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-[10px] text-ztextdim tracking-wide uppercase">Chain</div>
            <div className="text-sm font-mono text-white">{chain.length} strikes</div>
          </div>
          <div>
            <div className="text-[10px] text-ztextdim tracking-wide uppercase">Account</div>
            <div className="text-sm font-mono text-ztextdim">{accountId ? accountId.slice(0, 12) + '...' : '—'}</div>
          </div>
          <div>
            <div className="text-[10px] text-ztextdim tracking-wide uppercase">Session</div>
            <div className={`text-sm font-mono ${inSession ? 'text-zgreen' : 'text-ztextdim'}`}>
              {currentHHMM} {inSession ? '(active)' : '(closed)'}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-zborder">
          <ParamInput label="Max Cost" value={maxCost} onChange={setMaxCost} min={5} max={200} step={5} />
          <ParamInput label="Template" value={templateMove} onChange={setTemplateMove} min={5} max={20} step={2.5} />
          <ParamInput label="Min P&L" value={minPnl} onChange={setMinPnl} min={0} max={5} step={0.1} />
          <ParamInput label="Min Delta" value={minDelta} onChange={setMinDelta} min={0} max={1} step={0.05} />
          <ParamInput label="TP (pts)" value={tpPoints} onChange={setTpPoints} min={0} max={20} step={0.5} />
          <ParamInput label="SL (pts)" value={slPoints} onChange={setSlPoints} min={0} max={10} step={0.5} />
          <div>
            <label className="text-xs text-ztextdim tracking-wide uppercase">Start</label>
            <input type="time" value={sessionStart} onChange={e => setSessionStart(e.target.value)} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext" />
          </div>
          <div>
            <label className="text-xs text-ztextdim tracking-wide uppercase">End</label>
            <input type="time" value={sessionEnd} onChange={e => setSessionEnd(e.target.value)} className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext" />
          </div>
        </div>
        <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-zborder items-center">
          <div className="flex-1 min-w-0">
            <label className="text-xs text-ztextdim tracking-wide uppercase">Live API URL</label>
            <div className="flex gap-2">
              <input type="text" value={liveApiBase} onChange={e => setLiveApiBase(e.target.value)}
                className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext font-mono flex-1 min-w-0" />
              {liveApiBase !== window.location.origin && (
                <span className="text-zyellow text-xs self-center whitespace-nowrap">local mode</span>
              )}
            </div>
          </div>
          <button onClick={() => setLiveApiBase(window.location.origin)}
            className="px-3 py-1 text-xs rounded bg-zgray border border-zborder text-ztextdim hover:text-ztext shrink-0">
            Reset
          </button>
        </div>
        {error && <div className="mt-2 text-xs text-zred">{error}</div>}
      </div>

      {suggestions.length === 0 && openTrades.length === 0 && (
        <div className="panel-bg border border-zborder rounded-lg py-8 text-center text-ztextdim text-sm animate-fade-in">
          {chain.length === 0 ? 'Waiting for chain data...' : 'No qualifying combos at current spot level.'}
        </div>
      )}

      {!inSession && (
        <div className="bg-zyellow/10 border border-zyellow/30 rounded-lg p-3 text-xs text-zyellow text-center animate-fade-in">
          Outside session hours ({sessionStart}–{sessionEnd}). Trades will not be suggested.
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="space-y-2 animate-fade-in">
          <h3 className="text-sm font-medium text-ztextdim tracking-wide">Trade Suggestions</h3>
          {suggestions.map((trade, i) => (
            <div key={trade.id} className="panel-bg border border-zborder rounded-lg p-4 panel-hover">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-zcyan">#{i + 1}</span>
                    <span className="text-xs font-mono">
                      <span className="text-zgreen">{trade.legs.filter(l => l.type === 'call').map(l => `${l.strike.toFixed(0)}${l.quantity > 1 ? `x${l.quantity}` : ''}`).join('+')}</span>
                      {' / '}
                      <span className="text-zred">{trade.legs.filter(l => l.type === 'put').map(l => `${l.strike.toFixed(0)}${l.quantity > 1 ? `x${l.quantity}` : ''}`).join('+')}</span>
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs text-ztextdim">
                    <span className="tracking-wide">Cost: <span className="text-white font-mono tracking-normal">{trade.totalCost.toFixed(2)}</span></span>
                    <span className="tracking-wide">+{templateMove}: <span className="text-zgreen font-mono tracking-normal">+{trade.pnlPos.toFixed(2)}</span></span>
                    <span className="tracking-wide">−{templateMove}: <span className={`font-mono tracking-normal ${trade.pnlNeg >= 0 ? 'text-zgreen' : 'text-zred'}`}>{trade.pnlNeg >= 0 ? '+' : ''}{trade.pnlNeg.toFixed(2)}</span></span>
                    <span className="tracking-wide">Score: <span className="text-zpurple font-mono tracking-normal">{trade.score.toFixed(1)}</span></span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => acceptTrade(trade)} disabled={placing === trade.id}
                    className="px-3 py-1 text-xs font-medium rounded bg-zgreen/20 text-zgreen border border-zgreen hover:bg-zgreen/30 hover:shadow-[0_0_12px_rgba(34,197,94,0.2)] transition-all duration-200 disabled:opacity-50">
                    {placing === trade.id ? 'Placing...' : 'Enter'}
                  </button>
                  <button onClick={() => rejectTrade(trade.id)}
                    className="px-3 py-1 text-xs rounded bg-zgray border border-zborder text-ztextdim hover:text-ztext transition-all duration-200">Dismiss</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {openTrades.length > 0 && (
        <div className="space-y-2 animate-fade-in">
          <h3 className="text-sm font-medium text-ztextdim tracking-wide">Open Positions ({openTrades.length})</h3>
          {openTrades.map(trade => (
            <div key={trade.id} className="panel-bg border border-zborder rounded-lg p-4 panel-hover">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="text-xs font-mono">
                    <span className="text-zgreen">{trade.legs.filter(l => l.type === 'call').map(l => `${l.strike.toFixed(0)}${l.quantity > 1 ? `x${l.quantity}` : ''}`).join('+')}</span>
                    {' / '}
                    <span className="text-zred">{trade.legs.filter(l => l.type === 'put').map(l => `${l.strike.toFixed(0)}${l.quantity > 1 ? `x${l.quantity}` : ''}`).join('+')}</span>
                  </div>
                  <div className="flex gap-4 text-xs text-ztextdim">
                    <span className="tracking-wide">Entry: <span className="text-white font-mono tracking-normal">{trade.entryCost.toFixed(2)}</span></span>
                    <span className="tracking-wide">P&L: <span className={`font-mono tracking-normal ${trade.pnl >= 0 ? 'text-zgreen' : 'text-zred'}`}>{trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(2)}</span></span>
                    <span className="tracking-wide">P&L%: <span className={`font-mono tracking-normal ${trade.pnlPct >= 0 ? 'text-zgreen' : 'text-zred'}`}>{trade.pnlPct >= 0 ? '+' : ''}{trade.pnlPct.toFixed(1)}%</span></span>
                    {trade.entryTp > 0 && <span className="tracking-wide">TP: <span className="text-zgreen font-mono tracking-normal">+{trade.entryTp.toFixed(1)}</span></span>}
                    {trade.entrySl > 0 && <span className="tracking-wide">SL: <span className="text-zred font-mono tracking-normal">−{trade.entrySl.toFixed(1)}</span></span>}
                  </div>
                </div>
                <button onClick={() => closeTrade(trade)} disabled={closingIds.has(trade.id)}
                  className="px-3 py-1 text-xs rounded bg-zred/20 text-zred border border-zred hover:bg-zred/30 hover:shadow-[0_0_12px_rgba(239,68,68,0.2)] transition-all duration-200 disabled:opacity-50">
                  {closingIds.has(trade.id) ? 'Closing...' : 'Close'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
