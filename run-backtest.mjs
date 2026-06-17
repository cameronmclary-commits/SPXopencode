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

function surfacePrice(chain, strike, type, priceShift, useAsk) {
  const shifted = strike - priceShift
  const same = chain.filter(r => r.type === type).sort((a, b) => a.strike - b.strike)
  const getPrice = r => useAsk ? r.ask : r.bid
  if (same.length === 0) return 0.01
  if (shifted <= same[0].strike) return Math.max(0.01, getPrice(same[0]))
  if (shifted >= same[same.length - 1].strike) return Math.max(0.01, getPrice(same[same.length - 1]))
  let lo = 0, hi = same.length - 1
  while (hi - lo > 1) {
    const m = Math.floor((lo + hi) / 2)
    if (same[m].strike < shifted) lo = m; else hi = m
  }
  const t = (shifted - same[lo].strike) / (same[hi].strike - same[lo].strike)
  return getPrice(same[lo]) + t * (getPrice(same[hi]) - getPrice(same[lo]))
}

function numericDelta(chain, strike, type, spot) {
  const mid = (s, ps) => {
    const b = surfacePrice(chain, s, type, ps, false)
    const a = surfacePrice(chain, s, type, ps, true)
    return (b + a) / 2
  }
  const up = mid(strike, 1)
  const dn = mid(strike, -1)
  return (up - dn) / 2
}

function getConsecutiveGroups(arr, k) {
  if (arr.length < k) return []
  const sorted = [...arr].sort((a, b) => a.strike - b.strike)
  const r = []
  for (let i = 0; i <= sorted.length - k; i++) {
    const g = sorted.slice(i, i + k)
    const ok = g.every((_, j) => j === 0 || Math.abs(g[j].strike - g[j - 1].strike) === 5 || Math.abs(g[j].strike - g[j - 1].strike) === 0)
    if (ok) r.push(g)
  }
  return r
}

function findBest(chain, spot, maxCost, templateMove, minPnl10, minPnl, minPnlHalf, minSideDelta, minBalance, minGap, minSpotGap, maxStep) {
  const range = spot * 0.007
  const calls = chain.filter(r => r.type === 'call' && r.strike > spot - range && r.strike < spot + range).sort((a, b) => a.strike - b.strike)
  const puts = chain.filter(r => r.type === 'put' && r.strike < spot + range && r.strike > spot - range).sort((a, b) => a.strike - b.strike)
  let best = null, bestScore = -Infinity

  const evalCombo = (itm, otms) => {
    const ask = r => surfacePrice(chain, r.strike, r.type, 0, true)
    const bid = (r, move) => surfacePrice(chain, r.strike, r.type, move, false)

    const n = otms.length
    const search = (idx, chosen) => {
      if (idx === n) {
        let cost = ask(itm)
        let callDelta = 0, putDelta = 0
        const legs = [{ strike: itm.strike, type: itm.type, quantity: 1 }]
        const itmD = numericDelta(chain, itm.strike, itm.type, spot)
        if (itm.type === 'call') callDelta += itmD
        else putDelta += Math.abs(itmD)
        for (let i = 0; i < n; i++) {
          const q = chosen[i]; const r = otms[i]; const a = ask(r)
          cost += q * a
          legs.push({ strike: r.strike, type: r.type, quantity: q })
          const d = numericDelta(chain, r.strike, r.type, spot)
          if (r.type === 'call') callDelta += d
          else putDelta += Math.abs(d)
        }
        if (cost > maxCost) return
        if (Math.min(callDelta, putDelta) < minSideDelta) return
        if (minBalance > 0) {
          const mn = Math.min(callDelta, putDelta), mx = Math.max(callDelta, putDelta)
          if (mx > 0 && mn / mx < minBalance) return
        }
        if (minGap > 0) {
          const avgOtm = otms.reduce((s, r) => s + r.strike, 0) / otms.length
          const gap = itm.type === 'call' ? avgOtm - itm.strike : itm.strike - avgOtm
          if (gap < minGap) return
        }
        if (minSpotGap > 0) {
          const nearestOtmStrike = otms[itm.type === 'call' ? n - 1 : 0].strike
          const spotGap = itm.type === 'call' ? spot - nearestOtmStrike : nearestOtmStrike - spot
          if (spotGap < minSpotGap) return
        }
        const pnLat = move => legs.reduce((s, l) => s + l.quantity * surfacePrice(chain, l.strike, l.type, move, false), 0)
        const pnlPos = pnLat(templateMove) - cost
        const pnlNeg = pnLat(-templateMove) - cost
        const halfMove = templateMove / 2
        const pnl5Pos = pnLat(halfMove) - cost
        const pnl5Neg = pnLat(-halfMove) - cost
        if (Math.max(pnlPos, pnlNeg) < minPnl10 || Math.min(pnlPos, pnlNeg) < minPnl) return
        if (pnl5Pos < minPnlHalf || pnl5Neg < minPnlHalf) return
        if (maxStep > 0 && templateMove / Math.min(pnlPos, pnlNeg) > maxStep) return
        const sc = Math.min(pnlPos, pnlNeg, pnl5Pos, pnl5Neg)
        if (sc > bestScore || (sc === bestScore && cost < (best?.cost ?? Infinity))) {
          bestScore = sc
          best = { cost, score: sc, pnlPos, pnlNeg, pnl5Pos, pnl5Neg, legs }
        }
        return
      }
      for (let q = 1; q <= (idx === 0 ? 2 : 3); q++) {
        chosen.push(q)
        search(idx + 1, chosen)
        chosen.pop()
      }
    }
    search(0, [])
  }

  for (const itm of calls.filter(r => r.strike < spot)) {
    const otms = puts.filter(r => r.strike > itm.strike && r.strike < spot)
    if (otms.length < 2) continue
    for (const g of getConsecutiveGroups(otms, 2)) evalCombo(itm, g)
  }
  for (const itm of puts.filter(r => r.strike > spot)) {
    const otms = calls.filter(r => r.strike < itm.strike && r.strike > spot)
    if (otms.length < 2) continue
    for (const g of getConsecutiveGroups(otms, 2)) evalCombo(itm, g)
  }
  return best
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

async function run() {
  const sessions = await fetch('/api/sessions')
  const dates = sessions.sessions.filter(s => s.hasSnapshots).map(s => s.date)
  console.log(`Running backtest on ${dates.length} dates...`)

  const params = {
    maxCost: 70, scanInterval: 5, tpPoints: 0.8, slPoints: 4,
    templateMove: 10, minPnl10: 1, minPnl: 0.5, minPnlHalf: 0, minSideDelta: 0.5, minBalance: 0.85,
    minGap: 15, minSpotGap: 10, maxStep: 10
  }

  let cumPnl = 0
  let totalTrades = 0, wins = 0, losses = 0
  let totalWinPnl = 0, totalLossPnl = 0
  let maxDD = 0, peak = 0

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di]
    const [session, snapRes] = await Promise.all([
      fetch(`/api/sessions/${date}`),
      fetch(`/api/sessions/${date}/snapshots`).catch(() => ({ snapshots: [] }))
    ])
    const snapshots = snapRes.snapshots || []
    const pricePath = session.pricePath
    if (!pricePath?.length) continue

    const tradeStartMin = timeToMinutes('10:30')
    let openTrade = null, nextScanMin = tradeStartMin

    for (let tick = 0; tick < pricePath.length; tick++) {
      const spot = pricePath[tick].price
      const tickMin = timeToMinutes(pricePath[tick].time)
      const chain = snapshots[tick]?.chain || session.openingChain || []

      if (!openTrade && tickMin >= nextScanMin) {
        const pos = findBest(chain, spot, params.maxCost, params.templateMove, params.minPnl10, params.minPnl, params.minPnlHalf, params.minSideDelta, params.minBalance, params.minGap, params.minSpotGap, params.maxStep)
        if (pos) {
          openTrade = { ...pos, entryTick: tick, entrySpot: spot, entryTime: pricePath[tick].time }
          nextScanMin = tickMin + params.scanInterval
        }
      }

      if (openTrade && tick > openTrade.entryTick) {
        const currentVal = openTrade.legs.reduce((s, l) => s + l.quantity * surfacePrice(chain, l.strike, l.type, 0, false), 0)
        const pnl = currentVal - openTrade.cost

        let reason = null
        if (pnl >= params.tpPoints) reason = 'TP'
        else if (pnl <= -params.slPoints) reason = 'SL'

        if (reason) {
          cumPnl += pnl
          totalTrades++
          if (pnl > 0) { wins++; totalWinPnl += pnl } else { losses++; totalLossPnl += pnl }
          if (cumPnl > peak) peak = cumPnl
          const dd = peak > 0 ? (peak - cumPnl) / peak : 0
          if (dd > maxDD) maxDD = dd
          const legsStr = openTrade.legs.map(l => `${l.type[0]}${l.strike}${l.quantity > 1 ? 'x' + l.quantity : ''}`).join('+')
          console.log(`${date} ${reason} ${legsStr} cost=${openTrade.cost.toFixed(2)} spot=${openTrade.entrySpot} pnl=${pnl.toFixed(2)} p5=[${openTrade.pnl5Pos.toFixed(2)},${openTrade.pnl5Neg.toFixed(2)}] p10=[${openTrade.pnlPos.toFixed(2)},${openTrade.pnlNeg.toFixed(2)}]`)
          openTrade = null
          nextScanMin = tickMin
        }
      }
    }

    if (openTrade) {
      const finalTick = pricePath.length - 1
      const finalChain = snapshots[finalTick]?.chain || session.openingChain || []
      const finalVal = openTrade.legs.reduce((s, l) => s + l.quantity * surfacePrice(finalChain, l.strike, l.type, 0, false), 0)
      const pnl = finalVal - openTrade.cost
      cumPnl += pnl
      totalTrades++
      if (pnl > 0) { wins++; totalWinPnl += pnl } else { losses++; totalLossPnl += pnl }
      if (cumPnl > peak) peak = cumPnl
      const dd = peak > 0 ? (peak - cumPnl) / peak : 0
      if (dd > maxDD) maxDD = dd
      const legsStr = openTrade.legs.map(l => `${l.type[0]}${l.strike}${l.quantity > 1 ? 'x' + l.quantity : ''}`).join('+')
      console.log(`${date} EOS ${legsStr} cost=${openTrade.cost.toFixed(2)} spot=${openTrade.entrySpot} pnl=${pnl.toFixed(2)} p5=[${openTrade.pnl5Pos.toFixed(2)},${openTrade.pnl5Neg.toFixed(2)}] p10=[${openTrade.pnlPos.toFixed(2)},${openTrade.pnlNeg.toFixed(2)}]`)
    } else if (nextScanMin === -1) {
      console.log(`${date} no trade`)
    }
  }

  const winRate = totalTrades > 0 ? wins / totalTrades : 0
  const avgWin = wins > 0 ? totalWinPnl / wins : 0
  const avgLoss = losses > 0 ? totalLossPnl / losses : 0
  const pf = losses > 0 && avgLoss !== 0 ? Math.abs((wins * avgWin) / (losses * avgLoss)) : 0

  console.log(`\n=== RESULTS ===`)
  console.log(`Trades: ${totalTrades}`)
  console.log(`Win Rate: ${(winRate * 100).toFixed(1)}%`)
  console.log(`Total P&L: ${cumPnl.toFixed(2)} pts`)
  console.log(`Avg Win: ${avgWin.toFixed(2)} | Avg Loss: ${avgLoss.toFixed(2)}`)
  console.log(`Profit Factor: ${pf.toFixed(2)}`)
  console.log(`Max DD: ${(maxDD * 100).toFixed(1)}%`)
}

run().catch(console.error)
