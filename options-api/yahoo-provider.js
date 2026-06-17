import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import YahooFinance from 'yahoo-finance2'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSIONS_DIR = path.join(__dirname, 'data', 'live-sessions')

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })

let cached = null
let cacheTime = 0
const CACHE_TTL = 30_000

function getUsEasternDate() {
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return et.toISOString().slice(0, 10)
}

function saveToDisk(session) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const file = path.join(SESSIONS_DIR, `${session.date}.json`)
    fs.writeFileSync(file, JSON.stringify(session, null, 2))
  } catch (e) {
    console.error('Failed to save session:', e.message)
  }
}

export function listSessions() {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse()
  } catch { return [] }
}

export function loadSession(date) {
  try {
    const file = path.join(SESSIONS_DIR, `${date}.json`)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { return null }
}

export async function fetchLiveSession() {
  const now = Date.now()
  if (cached && now - cacheTime < CACHE_TTL) return cached

  const q = await yf.quote('^SPX')
  const spot = q.regularMarketPrice
  if (!spot) throw new Error('No SPX price from Yahoo')

  const todayStr = getUsEasternDate()
  const opts = await yf.options('^SPX', { date: todayStr })
  const chain = opts.options?.[0]
  if (!chain?.calls?.length || !chain?.puts?.length) throw new Error('No options chain for today')

  const calls = chain.calls.map(c => ({
    strike: c.strike,
    type: 'call',
    bid: c.bid ?? 0,
    ask: c.ask ?? 0,
    conid: c.contractSymbol,
  }))
  const puts = chain.puts.map(p => ({
    strike: p.strike,
    type: 'put',
    bid: p.bid ?? 0,
    ask: p.ask ?? 0,
    conid: p.contractSymbol,
  }))

  const nowDate = new Date()
  const timeStr = nowDate.toTimeString().slice(0, 5)

  const newSnapshot = { time: timeStr, chain: [...calls, ...puts] }
  const newPricePoint = { time: timeStr, price: spot }

  const result = {
    date: todayStr,
    spot,
    pricePath: cached ? [...cached.pricePath, newPricePoint] : [newPricePoint],
    openingChain: [...calls, ...puts],
    snapshots: cached ? [...cached.snapshots, newSnapshot] : [newSnapshot],
  }

  cached = result
  cacheTime = now
  saveToDisk(result)
  return result
}
