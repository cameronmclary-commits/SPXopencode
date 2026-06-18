import http from 'http'

const BASE = 'http://localhost:3080'

function fetch(path) {
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

// Interpolates a raw bid or ask quote for an arbitrary strike from the chain.
// useAsk=true -> ask quote. useAsk=false -> bid quote.
function surfacePrice(chain, strike, type, useAsk) {
  const same = chain.filter(r => r.type === type).sort((a, b) => a.strike - b.strike)
  const getPrice = r => useAsk ? r.ask : r.bid
  if (same.length === 0) return 0.01
  if (strike <= same[0].strike) return Math.max(0.01, getPrice(same[0]))
  if (strike >= same[same.length - 1].strike) return Math.max(0.01, getPrice(same[same.length - 1]))
  let lo = 0, hi = same.length - 1
  while (hi - lo > 1) {
    const m = Math.floor((lo + hi) / 2)
    if (same[m].strike < strike) lo = m; else hi = m
  }
  const t = (strike - same[lo].strike) / (same[hi].strike - same[lo].strike)
  return getPrice(same[lo]) + t * (getPrice(same[hi]) - getPrice(same[lo]))
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function round5(price) {
  return Math.round(price / 5) * 5
}

// Builds the 4 legs of an at-the-money iron condor with `wing` point wings:
// SELL call @ center, BUY call @ center+wing, SELL put @ center, BUY put @ center-wing
function buildLegs(center, wing) {
  return [
    { strike: center, type: 'call', quantity: -1 },
    { strike: center + wing, type: 'call', quantity: 1 },
    { strike: center, type: 'put', quantity: -1 },
    { strike: center - wing, type: 'put', quantity: 1 }
  ]
}

// Fill price for one leg's transaction.
//   opening a long leg  -> BUY  -> ask
//   opening a short leg -> SELL -> bid
//   closing a long leg  -> SELL -> bid
//   closing a short leg -> BUY  -> ask
function legFillPrice(chain, leg, isOpening) {
  const isBuy = isOpening ? leg.quantity > 0 : leg.quantity < 0
  if (isBuy) {
    return surfacePrice(chain, leg.strike, leg.type, true)
  }
  return Math.max(0.01, surfacePrice(chain, leg.strike, leg.type, false))
}

// cost = sum(qty * fillPrice) at OPEN -> negative cost == credit received
function legsCost(chain, legs) {
  return legs.reduce((s, l) => s + l.quantity * legFillPrice(chain, l, true), 0)
}

// value = sum(qty * fillPrice) if CLOSED right now
function legsValue(chain, legs) {
  return legs.reduce((s, l) => s + l.quantity * legFillPrice(chain, l, false), 0)
}

function nextGridEntry(prevSpot, currSpot, anchor, wing, tradedLevels) {
  if (prevSpot === currSpot) return null
  const lo = Math.min(prevSpot, currSpot)
  const hi = Math.max(prevSpot, currSpot)
  const firstN = Math.ceil((lo - anchor) / wing)
  const lastN = Math.floor((hi - anchor) / wing)
  const candidates = []
  for (let n = firstN; n <= lastN; n++) {
    const level = anchor + n * wing
    if (!tradedLevels.has(level)) candidates.push(level)
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => Math.abs(a - currSpot) - Math.abs(b - currSpot))
  return candidates[0]
}

async function run() {
  const sessions = await fetch('/api/sessions')
  const dates = sessions.sessions.filter(s => s.hasSnapshots).map(s => s.date)
  console.log(`Running Iron Condor grid-step backtest on ${dates.length} dates...`)

  const params = {
    wing: 15,
    tradeStartTime: '09:31',
    tradeEndTime: '15:45',
    closeAtPctOfCredit: 0.10,
    dollarMultiplier: 100
  }

  let cumPnlPts = 0
  let totalTrades = 0, wins = 0, losses = 0
  let totalWinPnl = 0, totalLossPnl = 0
  let maxDD = 0, peak = 0
  const dailyResults = []

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di]
    const [session, snapRes] = await Promise.all([
      fetch(`/api/sessions/${date}`),
      fetch(`/api/sessions/${date}/snapshots`).catch(() => ({ snapshots: [] }))
    ])
    const snapshots = snapRes.snapshots || []
    const pricePath = session.pricePath
    if (!pricePath?.length) continue

    const startMin = timeToMinutes(params.tradeStartTime)
    const endMin = timeToMinutes(params.tradeEndTime)

    let anchor = null
    const tradedLevels = new Set()
    const openPositions = []

    let dayPnlPts = 0, dayTrades = 0, dayWins = 0, dayLosses = 0

    function closePosition(pos, chain, tickMin, time, reason) {
      const exitVal = legsValue(chain, pos.legs)
      const pnlPts = exitVal - pos.cost
      cumPnlPts += pnlPts
      dayPnlPts += pnlPts
      totalTrades++; dayTrades++
      if (pnlPts > 0) { wins++; dayWins++; totalWinPnl += pnlPts }
      else { losses++; dayLosses++; totalLossPnl += pnlPts }
      if (cumPnlPts > peak) peak = cumPnlPts
      const dd = peak > 0 ? (peak - cumPnlPts) / peak : 0
      if (dd > maxDD) maxDD = dd
      const dollarPnl = pnlPts * params.dollarMultiplier
      console.log(`${date} ${time} CLOSE(${reason}) center=${pos.center} entry=${pos.entryTime}@${pos.entrySpot} credit=${pos.credit.toFixed(2)} pnl=${pnlPts.toFixed(2)}pts ($${dollarPnl.toFixed(2)})`)
    }

    for (let tick = 0; tick < pricePath.length; tick++) {
      const spot = pricePath[tick].price
      const tickMin = timeToMinutes(pricePath[tick].time)
      const chain = snapshots[tick]?.chain || session.openingChain || []
      const prevSpot = tick > 0 ? pricePath[tick - 1].price : spot

      if (tickMin < startMin) continue

      if (anchor === null && tickMin >= startMin) {
        anchor = round5(spot)
        tradedLevels.add(anchor)
        const legs = buildLegs(anchor, params.wing)
        const cost = legsCost(chain, legs)
        const credit = -cost
        openPositions.push({ center: anchor, legs, cost, credit, entryTick: tick, entryTime: pricePath[tick].time, entrySpot: spot })
        console.log(`${date} ${pricePath[tick].time} OPEN center=${anchor} spot=${spot} credit=${credit.toFixed(2)}`)
      } else if (anchor !== null && tickMin <= endMin) {
        const level = nextGridEntry(prevSpot, spot, anchor, params.wing, tradedLevels)
        if (level !== null) {
          tradedLevels.add(level)
          const legs = buildLegs(level, params.wing)
          const cost = legsCost(chain, legs)
          const credit = -cost
          openPositions.push({ center: level, legs, cost, credit, entryTick: tick, entryTime: pricePath[tick].time, entrySpot: spot })
          console.log(`${date} ${pricePath[tick].time} OPEN center=${level} spot=${spot} credit=${credit.toFixed(2)}`)
        }
      }

      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos = openPositions[i]
        if (tick <= pos.entryTick) continue
        const costToClose = -legsValue(chain, pos.legs)
        if (costToClose <= pos.credit * params.closeAtPctOfCredit) {
          closePosition(pos, chain, tickMin, pricePath[tick].time, 'TP')
          openPositions.splice(i, 1)
        } else if (tickMin >= endMin) {
          closePosition(pos, chain, tickMin, pricePath[tick].time, 'EOD')
          openPositions.splice(i, 1)
        }
      }
    }

    if (openPositions.length > 0) {
      const finalTick = pricePath.length - 1
      const finalChain = snapshots[finalTick]?.chain || session.openingChain || []
      for (const pos of openPositions) {
        closePosition(pos, finalChain, timeToMinutes(pricePath[finalTick].time), pricePath[finalTick].time, 'EOS')
      }
    }

    dailyResults.push({ date, trades: dayTrades, wins: dayWins, losses: dayLosses, pnlPts: dayPnlPts, pnlDollars: dayPnlPts * params.dollarMultiplier })
    console.log(`${date} SUMMARY: ${dayTrades} trades, ${dayWins}W/${dayLosses}L, P&L: ${dayPnlPts.toFixed(2)}pts ($${(dayPnlPts * params.dollarMultiplier).toFixed(2)})`)
  }

  const winRate = totalTrades > 0 ? wins / totalTrades : 0
  const avgWin = wins > 0 ? totalWinPnl / wins : 0
  const avgLoss = losses > 0 ? totalLossPnl / losses : 0
  const pf = losses > 0 && avgLoss !== 0 ? Math.abs((wins * avgWin) / (losses * avgLoss)) : 0

  console.log(`\n=== IRON CONDOR GRID-STEP RESULTS ===`)
  console.log(`Trading Days: ${dailyResults.length}`)
  console.log(`Total Trades: ${totalTrades}`)
  console.log(`Win Rate: ${(winRate * 100).toFixed(1)}%`)
  console.log(`Total P&L: ${cumPnlPts.toFixed(2)} pts ($${(cumPnlPts * params.dollarMultiplier).toFixed(2)})`)
  console.log(`Avg Win: ${avgWin.toFixed(2)}pts | Avg Loss: ${avgLoss.toFixed(2)}pts`)
  console.log(`Profit Factor: ${pf.toFixed(2)}`)
  console.log(`Max Drawdown: ${(maxDD * 100).toFixed(1)}%`)
}

run().catch(console.error)
