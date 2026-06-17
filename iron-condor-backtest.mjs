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

/**
 * Find the closest strike at or below the target price
 */
function getStrikeAtOrBelow(chain, targetStrike, type) {
  const options = chain.filter(r => r.type === type).sort((a, b) => b.strike - a.strike)
  for (const opt of options) {
    if (opt.strike <= targetStrike) return opt
  }
  return null
}

/**
 * Get price for a specific strike and type
 */
function getOptionPrice(chain, strike, type, useMid = true) {
  const option = chain.find(r => r.strike === strike && r.type === type)
  if (!option) return null
  if (useMid) return (option.bid + option.ask) / 2
  return { bid: option.bid, ask: option.ask, mid: (option.bid + option.ask) / 2 }
}

/**
 * Calculate the cost/credit of an Iron Condor
 * Sell 1 Call @ shortCallStrike
 * Buy 1 Call @ shortCallStrike + 15
 * Sell 1 Put @ shortPutStrike
 * Buy 1 Put @ shortPutStrike - 15
 *
 * Returns: credit (positive = we receive), or null if strikes missing
 */
function getIronCondorCredit(chain, spot) {
  const shortCallStrike = Math.ceil(spot / 5) * 5
  const longCallStrike = shortCallStrike + 15
  const shortPutStrike = Math.floor(spot / 5) * 5
  const longPutStrike = shortPutStrike - 15

  const shortCall = getOptionPrice(chain, shortCallStrike, 'call')
  const longCall = getOptionPrice(chain, longCallStrike, 'call')
  const shortPut = getOptionPrice(chain, shortPutStrike, 'put')
  const longPut = getOptionPrice(chain, longPutStrike, 'put')

  if (!shortCall || !longCall || !shortPut || !longPut) return null

  const credit = (shortCall + shortPut) - (longCall + longPut)
  
  return {
    credit: Math.round(credit * 100) / 100,
    shortCallStrike,
    longCallStrike,
    shortPutStrike,
    longPutStrike,
    legs: [
      { type: 'call', strike: shortCallStrike, action: 'sell', price: shortCall },
      { type: 'call', strike: longCallStrike, action: 'buy', price: longCall },
      { type: 'put', strike: shortPutStrike, action: 'sell', price: shortPut },
      { type: 'put', strike: longPutStrike, action: 'buy', price: longPut },
    ]
  }
}

/**
 * Calculate current mark of an Iron Condor position
 */
function getIronCondorMark(chain, shortCallStrike, longCallStrike, shortPutStrike, longPutStrike) {
  const shortCall = getOptionPrice(chain, shortCallStrike, 'call')
  const longCall = getOptionPrice(chain, longCallStrike, 'call')
  const shortPut = getOptionPrice(chain, shortPutStrike, 'put')
  const longPut = getOptionPrice(chain, longPutStrike, 'put')

  if (!shortCall || !longCall || !shortPut || !longPut) return null

  // For closed positions, cost to buyback
  const cost = (shortCall + shortPut) - (longCall + longPut)
  return Math.round(cost * 100) / 100
}

/**
 * Main backtest function
 */
async function run() {
  try {
    const sessions = await fetch('/api/sessions')
    const dates = sessions.sessions.filter(s => s.hasSnapshots).map(s => s.date)
    
    if (dates.length === 0) {
      console.log('No sessions with snapshots available')
      return
    }

    console.log(`Running Iron Condor progressive strategy on ${dates.length} dates...\n`)

    // Parameters
    const params = {
      initialSpotOffset: 0,    // ATM
      wingWidth: 15,           // 15 points
      scalingDistance: 15,     // Sell again when price moves 15pts
      tradeStartTime: '10:30', // Start trading at 10:30 ET
      tradeEndTime: '15:45',   // Stop trading at 15:45 ET (close before 4pm)
    }

    let totalDays = 0
    let daysWithTrades = 0
    let totalTrades = 0
    let totalCredit = 0
    let profitableTrades = 0
    let maxDD = 0
    let peakCapital = 0

    for (const date of dates) {
      const [session, snapsRes] = await Promise.all([
        fetch(`/api/sessions/${date}`),
        fetch(`/api/sessions/${date}/snapshots`).catch(() => ({ snapshots: [] }))
      ])

      const snapshots = snapsRes.snapshots || []
      if (snapshots.length === 0) continue

      totalDays++
      let dayCredit = 0
      let dayProfitableTrades = 0
      let dayTotalTrades = 0
      let dayPeakCapital = 0

      // Active positions: track all open Iron Condors
      const positions = []
      let nextScaleSpot = null

      const timeToMinutes = t => {
        const [h, m] = t.split(':').map(Number)
        return h * 60 + m
      }

      const tradeStartMin = timeToMinutes(params.tradeStartTime)
      const tradeEndMin = timeToMinutes(params.tradeEndTime)

      // Process each minute
      for (let i = 0; i < snapshots.length; i++) {
        const snap = snapshots[i]
        const [h, m] = snap.time.split(':').map(Number)
        const curMin = h * 60 + m
        const spot = snap.spot
        const chain = snap.chain

        // Check if any positions should be closed
        for (let pi = positions.length - 1; pi >= 0; pi--) {
          const pos = positions[pi]
          const mark = getIronCondorMark(chain, pos.shortCall, pos.longCall, pos.shortPut, pos.longPut)
          
          if (mark === null) continue

          // Track unrealized P&L
          pos.currentMark = mark
          pos.unrealizedPnl = pos.credit - mark

          // Close when mark approaches 0 or reverses (early close for profit)
          const closeThreshold = Math.max(0.05, pos.credit * 0.1) // 10% of credit or $0.05
          if (mark <= closeThreshold || pos.unrealizedPnl >= pos.credit * 0.9) {
            // Position closed
            pos.closedAtTime = snap.time
            pos.closedAtSpot = spot
            pos.closedMark = mark
            pos.finalPnl = pos.credit - mark
            dayCredit += pos.finalPnl
            dayTotalTrades++
            dayProfitableTrades += pos.finalPnl > 0 ? 1 : 0

            positions.splice(pi, 1)
            continue
          }
        }

        // Check if we should sell a new Iron Condor
        if (curMin >= tradeStartMin && curMin <= tradeEndMin) {
          // Determine if we should scale in
          const shouldScale = 
            nextScaleSpot === null || 
            Math.abs(spot - nextScaleSpot) >= params.scalingDistance

          if (shouldScale) {
            const ic = getIronCondorCredit(chain, spot)
            if (ic && ic.credit > 0) {
              positions.push({
                enteredAtTime: snap.time,
                enteredAtSpot: spot,
                credit: ic.credit,
                shortCall: ic.shortCallStrike,
                longCall: ic.longCallStrike,
                shortPut: ic.shortPutStrike,
                longPut: ic.longPutStrike,
                legs: ic.legs,
                currentMark: ic.credit,
                unrealizedPnl: 0,
              })

              totalTrades++
              nextScaleSpot = spot
            }
          }
        } else if (curMin > tradeEndMin && positions.length > 0) {
          // Market close: close all remaining positions
          for (const pos of positions) {
            const mark = getIronCondorMark(chain, pos.shortCall, pos.longCall, pos.shortPut, pos.longPut)
            if (mark !== null) {
              pos.closedAtTime = snap.time
              pos.closedAtSpot = spot
              pos.closedMark = mark
              pos.finalPnl = pos.credit - mark
              dayCredit += pos.finalPnl
              dayTotalTrades++
              dayProfitableTrades += pos.finalPnl > 0 ? 1 : 0
            }
          }
          positions.length = 0
        }

        // Track capital waterline
        const currentCapital = dayCredit + positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
        if (currentCapital > dayPeakCapital) dayPeakCapital = currentCapital
      }

      // Close any remaining positions at end of day
      if (positions.length > 0) {
        const lastSnap = snapshots[snapshots.length - 1]
        for (const pos of positions) {
          const mark = getIronCondorMark(lastSnap.chain, pos.shortCall, pos.longCall, pos.shortPut, pos.longPut)
          if (mark !== null) {
            pos.closedAtTime = lastSnap.time
            pos.closedAtSpot = lastSnap.spot
            pos.closedMark = mark
            pos.finalPnl = pos.credit - mark
            dayCredit += pos.finalPnl
            dayTotalTrades++
            dayProfitableTrades += pos.finalPnl > 0 ? 1 : 0
          }
        }
      }

      if (dayTotalTrades > 0) {
        daysWithTrades++
        console.log(`${date}: ${dayTotalTrades} trades, Credit: $${dayCredit.toFixed(2)}, Win Rate: ${(dayProfitableTrades / dayTotalTrades * 100).toFixed(1)}%`)
      }

      totalCredit += dayCredit
      profitableTrades += dayProfitableTrades
      totalTrades += dayTotalTrades
      peakCapital = Math.max(peakCapital, dayPeakCapital)
    }

    const winRate = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0
    const avgPerTrade = totalTrades > 0 ? totalCredit / totalTrades : 0

    console.log(`\n${'='.repeat(50)}`)
    console.log(`IRON CONDOR STRATEGY RESULTS`)
    console.log(`${'='.repeat(50)}`)
    console.log(`Trading Days Analyzed: ${totalDays}`)
    console.log(`Days with Trades: ${daysWithTrades}`)
    console.log(`Total Trades: ${totalTrades}`)
    console.log(`Profitable Trades: ${profitableTrades}`)
    console.log(`Win Rate: ${winRate.toFixed(1)}%`)
    console.log(`Total Credit Collected: $${totalCredit.toFixed(2)}`)
    console.log(`Average Per Trade: $${avgPerTrade.toFixed(2)}`)
    console.log(`Peak Capital: $${peakCapital.toFixed(2)}`)
    console.log(`${'='.repeat(50)}`)

  } catch (err) {
    console.error('Error:', err.message)
  }
}

run().catch(console.error)
