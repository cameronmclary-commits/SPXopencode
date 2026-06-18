// iron-condor-dashboard.mjs
// -----------------------------------------------------------------------------
// Node CLI runner for the SPX 0DTE iron-condor grid-step strategy.
// All strategy logic lives in ./iron-condor-engine.js — this file just wires
// up an http.get-based fetchJSON and prints results to stdout.
//
// Usage:
//   1. Make sure options-api is running on port 3080
//      (npm start inside the options-api folder)
//   2. node iron-condor-dashboard.mjs
//
// Override PARAMS below to change strategy defaults without touching the engine.
// -----------------------------------------------------------------------------

import http from 'http'
import { PARAMS as DEFAULT_PARAMS, backtestDay, aggregateStats } from './iron-condor-engine.js'

const BASE = 'http://localhost:3080'

// Override PARAMS here to change strategy defaults without touching the engine.
const PARAMS = { ...DEFAULT_PARAMS }

// http.get-based fetchJSON — passed into the engine so the engine itself stays
// environment-agnostic. The browser dashboard supplies its own native-fetch
// wrapper of the same shape.
function fetchJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error(data)) }
      })
    }).on('error', reject)
  })
}

function fmtDollars(n) {
  const sign = n < 0 ? '-' : '+'
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

async function run() {
  const sessions = await fetchJSON('/api/sessions')
  const dates = sessions.sessions.filter(s => s.hasSnapshots).map(s => s.date).sort()
  console.log(`Running Iron Condor grid-step backtest on ${dates.length} dates...`)
  console.log(`Params:`, PARAMS)
  console.log('')

  const days = []
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i]
    process.stdout.write(`[${i + 1}/${dates.length}] ${date} ... `)
    try {
      const day = await backtestDay(date, PARAMS, fetchJSON)
      if (day) {
        days.push(day)
        const w = day.trades.filter(t => t.pnlPts > 0).length
        const l = day.trades.length - w
        const dollars = day.dayPnlPts * PARAMS.dollarMultiplier
        console.log(`${day.trades.length} trades, ${w}W/${l}L, ${day.dayPnlPts >= 0 ? '+' : ''}${day.dayPnlPts.toFixed(2)}pts (${fmtDollars(dollars)})`)
        for (const t of day.trades) {
          const d = t.pnlPts * PARAMS.dollarMultiplier
          const sign = t.pnlPts >= 0 ? '+' : ''
          const dsign = d >= 0 ? '+' : ''
          console.log(
            `    ${t.entryTime} center=${t.center} credit=${t.credit.toFixed(2)} -> ${t.reason.padEnd(3)} ` +
            `${sign}${t.pnlPts.toFixed(2)}pts (${fmtDollars(d)})`
          )
        }
      } else {
        console.log('no data')
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
    }
  }

  console.log('')
  const stats = aggregateStats(days, PARAMS)
  console.log(`=== IRON CONDOR GRID-STEP RESULTS ===`)
  console.log(`Trading Days: ${stats.days}`)
  console.log(`Total Trades: ${stats.totalTrades}  (${stats.wins}W / ${stats.losses}L)`)
  console.log(`Win Rate:     ${(stats.winRate * 100).toFixed(1)}%`)
  console.log(`Total P&L:    ${stats.cumPnlPts.toFixed(2)} pts (${fmtDollars(stats.cumPnlDollars)})`)
  console.log(`Avg Win:      ${stats.avgWin.toFixed(2)} pts`)
  console.log(`Avg Loss:     ${stats.avgLoss.toFixed(2)} pts`)
  console.log(`Profit Factor: ${stats.profitFactor.toFixed(2)}`)
  console.log(`Max Drawdown: ${(stats.maxDrawdown * 100).toFixed(1)}%`)
}

run().catch(err => {
  console.error('Fatal:', err.message)
  console.error('')
  console.error('Make sure options-api is running on port 3080 (npm start inside the options-api folder).')
  process.exit(1)
})
