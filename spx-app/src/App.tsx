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
import LiveAnalysis from './components/LiveAnalysis'
import LivePlayback from './components/LivePlayback'
import PreMarket from './components/PreMarket'
import PlaybackTab from './components/PlaybackTab'
import SurfaceTab from './components/SurfaceTab'
import MarkoutTab from './components/MarkoutTab'
import ErrorBoundary from './components/shared/ErrorBoundary'

type Tab = 'overview' | 'chain' | 'scanner' | 'lab' | 'monitoring' | 'historical' | 'premarket' | 'backtest' | 'live' | 'liveanalysis' | 'liveplayback' | 'playback' | 'surface' | 'markout'

const tabs: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'chain', label: 'Chain' },
  { id: 'scanner', label: 'Scanner' },
  { id: 'lab', label: 'Trade Lab' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'playback', label: 'Playback' },
  { id: 'surface', label: 'Surface' },
  { id: 'markout', label: 'Markout' },
  { id: 'liveanalysis', label: 'Analysis' },
  { id: 'liveplayback', label: 'Replay' },
  { id: 'live', label: 'Live' },
  { id: 'monitoring', label: 'Monitor' },
  { id: 'historical', label: 'Historical' },
  { id: 'premarket', label: 'Pre-Market' },
]

const LIVE_MODE = '__live__'

const isLiveMode = (d: string) => d === LIVE_MODE

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedDate, setSelectedDate] = useState(LIVE_MODE)
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [apiStatus, setApiStatus] = useState<'checking' | 'online' | 'offline'>('checking')

  const dataSource = isLiveMode(selectedDate) ? 'live' as const : 'historical' as const

  useEffect(() => {
    checkHealth()
      .then(() => setApiStatus('online'))
      .catch(() => setApiStatus('offline'))
  }, [])

  useEffect(() => {
    fetchSessions()
      .then(setSessions)
      .catch(() => setApiStatus('offline'))
  }, [])

  const loadSession = useCallback(async (date: string) => {
    if (isLiveMode(date)) { setSessionData(null); return }
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
    <div className="min-h-screen text-ztext">
      <header className="sticky top-0 z-50">
        <div className="absolute inset-0 border-b border-zborder/80 bg-zgray/60 backdrop-blur-md" />
        <div className="relative max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-white tracking-tight" style={{ textShadow: '0 0 20px rgba(6, 182, 212, 0.15)' }}>
              Zero<span className="text-zcyan" style={{ textShadow: '0 0 20px rgba(6, 182, 212, 0.4)' }}>D</span>
            </span>
            <span className="text-xs text-ztextdim hidden sm:inline font-medium tracking-wide uppercase">SPX 0DTE Dashboard</span>
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
        <nav className="relative max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-3 py-2 text-sm font-medium whitespace-nowrap transition-all duration-200 ${
                tab === t.id
                  ? 'text-zcyan'
                  : 'text-ztextdim hover:text-ztext'
              }`}
            >
              {t.label}
              {tab === t.id && (
                <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-zcyan rounded-full animate-fade-in" style={{ boxShadow: '0 0 8px rgba(6, 182, 212, 0.5)' }} />
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <ErrorBoundary>
          {sessions.length > 0 && (
            <div className="mb-4 flex items-center gap-2 animate-fade-in">
              <label className="text-xs text-ztextdim tracking-wide uppercase">Session:</label>
              <div className="flex items-center gap-2">
                <select
                  value={selectedDate}
                  onChange={e => setSelectedDate(e.target.value)}
                  className="bg-zgray border border-zborder rounded px-2 py-1 text-sm text-ztext"
                >
                  <option value={LIVE_MODE}>Today (Live)</option>
                  <optgroup label="── Historical ──">
                    {sessions.map(s => (
                      <option key={s.date} value={s.date}>{s.date}</option>
                    ))}
                  </optgroup>
                </select>
                <span className={`text-xs font-semibold tracking-wider uppercase px-2 py-0.5 rounded ${
                  dataSource === 'live'
                    ? 'text-zgreen bg-zgreen/10 border border-zgreen/30'
                    : 'text-zamber bg-zamber/10 border border-zamber/30'
                }`}>
                  {dataSource === 'live' ? 'Live' : 'Historical'}
                </span>
              </div>
              {loading && <span className="text-xs text-ztextdim animate-pulse">loading...</span>}
            </div>
          )}

          {tab === 'overview' && <Overview data={sessionData} loading={loading} />}
          {tab === 'chain' && <ChainTab date={selectedDate} />}
          {tab === 'scanner' && <TradeScanner date={selectedDate} chain={sessionData?.openingChain || []} spotPrice={sessionData?.spotPrice || 0} />}
          {tab === 'lab' && <TradeLab selectedDate={selectedDate} />}
          {tab === 'backtest' && <BacktestTab sessions={sessions} />}
          {tab === 'playback' && <PlaybackTab sessions={sessions} />}
          {tab === 'live' && <LiveTab sessions={sessions} />}
          {tab === 'liveanalysis' && <LiveAnalysis />}
          {tab === 'liveplayback' && <LivePlayback />}
          {tab === 'monitoring' && <Monitoring />}
          {tab === 'historical' && <HistoricalTab sessions={sessions} />}
          {tab === 'premarket' && <PreMarket />}
          {tab === 'surface' && <SurfaceTab sessions={sessions} />}
          {tab === 'markout' && <MarkoutTab sessions={sessions} />}
        </ErrorBoundary>
      </main>
    </div>
  )
}
