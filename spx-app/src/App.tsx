import { useState, useEffect, useCallback } from 'react'
import type { SessionInfo, SessionData } from './types'
import { fetchSessions, fetchSession, checkHealth } from './api'
import Overview from './components/Overview'
import ChainTab from './components/ChainTab'
import TradeScanner from './components/TradeScanner'
import TradeLab from './components/TradeLab'
import Monitoring from './components/Monitoring'
import HistoricalTab from './components/HistoricalTab'
import BacktestTab from './components/BacktestTab'
import LiveTab from './components/LiveTab'

type Tab = 'overview' | 'chain' | 'scanner' | 'lab' | 'monitoring' | 'historical' | 'premarket' | 'backtest' | 'live'

const tabs: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'chain', label: 'Chain' },
  { id: 'scanner', label: 'Scanner' },
  { id: 'lab', label: 'Trade Lab' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'live', label: 'Live' },
  { id: 'monitoring', label: 'Monitor' },
  { id: 'historical', label: 'Historical' },
  { id: 'premarket', label: 'Pre-Market' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [apiStatus, setApiStatus] = useState<'checking' | 'online' | 'offline'>('checking')

  useEffect(() => {
    checkHealth()
      .then(() => setApiStatus('online'))
      .catch(() => setApiStatus('offline'))
  }, [])

  useEffect(() => {
    fetchSessions()
      .then(s => {
        setSessions(s)
        if (s.length > 0 && !selectedDate) setSelectedDate(s[0].date)
      })
      .catch(() => {})
  }, [selectedDate])

  const loadSession = useCallback(async (date: string) => {
    setLoading(true)
    try {
      const data = await fetchSession(date)
      setSessionData(data)
    } catch {
      setSessionData(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (selectedDate) loadSession(selectedDate)
  }, [selectedDate, loadSession])

  return (
    <div className="min-h-screen bg-zdark text-ztext">
      <header className="border-b border-zborder bg-zgray/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-white tracking-tight">
              Zero<span className="text-zcyan">D</span>
            </span>
            <span className="text-xs text-ztextdim hidden sm:inline">SPX 0DTE Dashboard</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${
              apiStatus === 'online' ? 'bg-zgreen' : apiStatus === 'offline' ? 'bg-zred' : 'bg-zyellow animate-pulse'
            }`} />
            <span className="text-xs text-ztextdim">
              {apiStatus === 'online' ? `${sessions.length} dates` : apiStatus === 'offline' ? 'offline' : 'connecting'}
            </span>
          </div>
        </div>
        <nav className="max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto pb-px">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-zcyan text-zcyan'
                  : 'border-transparent text-ztextdim hover:text-ztext hover:border-zborder'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {sessions.length > 0 && (
          <div className="mb-4 flex items-center gap-2">
            <label className="text-xs text-ztextdim">Session:</label>
            <select
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className="bg-zgray border border-zborder rounded px-2 py-1 text-sm text-ztext"
            >
              {sessions.map(s => (
                <option key={s.date} value={s.date}>{s.date}</option>
              ))}
            </select>
            {loading && <span className="text-xs text-ztextdim animate-pulse">loading...</span>}
          </div>
        )}

        {tab === 'overview' && <Overview data={sessionData} loading={loading} />}
        {tab === 'chain' && <ChainTab date={selectedDate} />}
        {tab === 'scanner' && <TradeScanner date={selectedDate} chain={sessionData?.openingChain || []} spotPrice={sessionData?.spotPrice || 0} />}
        {tab === 'lab' && <TradeLab selectedDate={selectedDate} />}
        {tab === 'backtest' && <BacktestTab sessions={sessions} />}
        {tab === 'live' && <LiveTab />}
        {tab === 'monitoring' && <Monitoring />}
        {tab === 'historical' && <HistoricalTab sessions={sessions} />}
      </main>
    </div>
  )
}
