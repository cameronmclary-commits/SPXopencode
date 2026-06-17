import http from 'http'
import fs from 'fs'
import path from 'path'

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

  const cost = (shortCall + shortPut) - (longCall + longPut)
  return Math.round(cost * 100) / 100
}

/**
 * Generate HTML chart for visualization
 */
function generateHTMLChart(data) {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Iron Condor Strategy Backtest Results</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            padding: 20px;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        .header h1 {
            font-size: 32px;
            margin-bottom: 10px;
            color: #22c55e;
        }
        .metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 40px;
        }
        .metric-card {
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
        }
        .metric-label {
            font-size: 12px;
            color: #94a3b8;
            text-transform: uppercase;
            margin-bottom: 8px;
            letter-spacing: 0.5px;
        }
        .metric-value {
            font-size: 24px;
            font-weight: bold;
            color: #22c55e;
        }
        .metric-value.negative {
            color: #ef4444;
        }
        .metric-value.neutral {
            color: #94a3b8;
        }
        .charts {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
            gap: 30px;
            margin-bottom: 40px;
        }
        .chart-container {
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 8px;
            padding: 20px;
            position: relative;
        }
        .chart-title {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 15px;
            color: #cbd5e1;
        }
        .chart-wrapper {
            position: relative;
            height: 400px;
        }
        .summary-table {
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 8px;
            overflow: hidden;
            margin-top: 30px;
        }
        .summary-table thead {
            background: #0f172a;
            border-bottom: 2px solid #334155;
        }
        .summary-table th {
            padding: 15px;
            text-align: left;
            font-size: 12px;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 600;
        }
        .summary-table td {
            padding: 12px 15px;
            border-bottom: 1px solid #334155;
            font-size: 14px;
        }
        .summary-table tbody tr:hover {
            background: #0f172a;
        }
        .summary-table tbody tr:last-child td {
            border-bottom: none;
        }
        .profit { color: #22c55e; }
        .loss { color: #ef4444; }
        .neutral { color: #94a3b8; }
        .footer {
            text-align: center;
            margin-top: 40px;
            font-size: 12px;
            color: #64748b;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 Iron Condor Strategy Backtest</h1>
            <p>Progressive selling strategy with 1-minute OPRA data</p>
        </div>

        <div class="metrics">
            <div class="metric-card">
                <div class="metric-label">Total Trades</div>
                <div class="metric-value">${data.summary.totalTrades}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Win Rate</div>
                <div class="metric-value">${data.summary.winRate.toFixed(1)}%</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Total P&L</div>
                <div class="metric-value ${data.summary.totalPnl >= 0 ? '' : 'negative'}">$${data.summary.totalPnl.toFixed(2)}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Avg Per Trade</div>
                <div class="metric-value ${data.summary.avgPerTrade >= 0 ? '' : 'negative'}">$${data.summary.avgPerTrade.toFixed(2)}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Profit Factor</div>
                <div class="metric-value">${data.summary.profitFactor.toFixed(2)}x</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Max Drawdown</div>
                <div class="metric-value negative">${data.summary.maxDrawdown.toFixed(2)}%</div>
            </div>
        </div>

        <div class="charts">
            <div class="chart-container">
                <div class="chart-title">📈 Cumulative P&L Over Time</div>
                <div class="chart-wrapper">
                    <canvas id="pnlChart"></canvas>
                </div>
            </div>
            <div class="chart-container">
                <div class="chart-title">📊 Daily P&L Distribution</div>
                <div class="chart-wrapper">
                    <canvas id="dailyChart"></canvas>
                </div>
            </div>
            <div class="chart-container">
                <div class="chart-title">🏆 Win/Loss by Day</div>
                <div class="chart-wrapper">
                    <canvas id="winLossChart"></canvas>
                </div>
            </div>
            <div class="chart-container">
                <div class="chart-title">💰 Trade Size Distribution</div>
                <div class="chart-wrapper">
                    <canvas id="tradeDistChart"></canvas>
                </div>
            </div>
        </div>

        <div class="summary-table">
            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Trades</th>
                        <th>Wins</th>
                        <th>Losses</th>
                        <th>Win Rate</th>
                        <th>Daily P&L</th>
                        <th>Avg Trade</th>
                        <th>Cumulative P&L</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.dailyData.map((day, idx) => `
                        <tr>
                            <td>${day.date}</td>
                            <td>${day.tradesCount}</td>
                            <td class="profit">${day.wins}</td>
                            <td class="loss">${day.losses}</td>
                            <td>${day.winRate.toFixed(1)}%</td>
                            <td class="${day.dailyPnl >= 0 ? 'profit' : 'loss'}">$${day.dailyPnl.toFixed(2)}</td>
                            <td class="${day.avgTrade >= 0 ? 'profit' : 'loss'}">$${day.avgTrade.toFixed(2)}</td>
                            <td class="${day.cumulativePnl >= 0 ? 'profit' : 'loss'}">$${day.cumulativePnl.toFixed(2)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <div class="footer">
            Generated on ${new Date().toLocaleString()} | Strategy runs 10:30 AM - 3:45 PM ET | 15-point progressive scaling
        </div>
    </div>

    <script>
        const chartDefaults = {
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            borderColor: '#22c55e',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointBackgroundColor: '#22c55e',
            pointBorderColor: '#1e293b',
            pointBorderWidth: 2,
            pointHoverRadius: 6,
        };

        // Cumulative P&L Chart
        const ctx1 = document.getElementById('pnlChart').getContext('2d');
        new Chart(ctx1, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(data.cumulativePnlChart.labels)},
                datasets: [{
                    label: 'Cumulative P&L',
                    data: ${JSON.stringify(data.cumulativePnlChart.data)},
                    ...chartDefaults,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    filler: { propagate: true }
                },
                scales: {
                    x: { display: false },
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(148, 163, 184, 0.1)' },
                        ticks: { color: '#94a3b8' }
                    }
                }
            }
        });

        // Daily P&L Distribution
        const ctx2 = document.getElementById('dailyChart').getContext('2d');
        new Chart(ctx2, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(data.dailyPnlChart.labels)},
                datasets: [{
                    label: 'Daily P&L',
                    data: ${JSON.stringify(data.dailyPnlChart.data)},
                    backgroundColor: ${JSON.stringify(data.dailyPnlChart.colors)},
                    borderRadius: 4,
                    borderSkipped: false,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#94a3b8', maxRotation: 45, minRotation: 0 } },
                    y: { grid: { color: 'rgba(148, 163, 184, 0.1)' }, ticks: { color: '#94a3b8' } }
                }
            }
        });

        // Win/Loss by Day
        const ctx3 = document.getElementById('winLossChart').getContext('2d');
        new Chart(ctx3, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(data.winLossChart.labels)},
                datasets: [
                    {
                        label: 'Wins',
                        data: ${JSON.stringify(data.winLossChart.wins)},
                        backgroundColor: 'rgba(34, 197, 94, 0.8)',
                    },
                    {
                        label: 'Losses',
                        data: ${JSON.stringify(data.winLossChart.losses)},
                        backgroundColor: 'rgba(239, 68, 68, 0.8)',
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: '#94a3b8' } },
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#94a3b8', maxRotation: 45, minRotation: 0 }, stacked: true },
                    y: { grid: { color: 'rgba(148, 163, 184, 0.1)' }, ticks: { color: '#94a3b8' }, stacked: true }
                }
            }
        });

        // Trade Size Distribution
        const ctx4 = document.getElementById('tradeDistChart').getContext('2d');
        new Chart(ctx4, {
            type: 'doughnut',
            data: {
                labels: ${JSON.stringify(data.tradeDistChart.labels)},
                datasets: [{
                    data: ${JSON.stringify(data.tradeDistChart.data)},
                    backgroundColor: [
                        'rgba(34, 197, 94, 0.8)',
                        'rgba(59, 130, 246, 0.8)',
                        'rgba(249, 115, 22, 0.8)',
                        'rgba(168, 85, 247, 0.8)',
                    ],
                    borderColor: '#1e293b',
                    borderWidth: 2,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: '#94a3b8' } },
                }
            }
        });
    </script>
</body>
</html>`
}

/**
 * Main backtest function with visualization
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

    const params = {
      initialSpotOffset: 0,
      wingWidth: 15,
      scalingDistance: 15,
      tradeStartTime: '10:30',
      tradeEndTime: '15:45',
    }

    let totalTrades = 0
    let profitableTrades = 0
    let totalPnl = 0
    let totalWinPnl = 0
    let totalLossPnl = 0
    let peakCapital = 0
    let maxDD = 0
    let peak = 0

    const dailyData = []
    const cumulativePnlPoints = []
    let runningPnl = 0

    const timeToMinutes = t => {
      const [h, m] = t.split(':').map(Number)
      return h * 60 + m
    }

    const tradeStartMin = timeToMinutes(params.tradeStartTime)
    const tradeEndMin = timeToMinutes(params.tradeEndTime)

    for (const date of dates) {
      const [session, snapsRes] = await Promise.all([
        fetch(`/api/sessions/${date}`),
        fetch(`/api/sessions/${date}/snapshots`).catch(() => ({ snapshots: [] }))
      ])

      const snapshots = snapsRes.snapshots || []
      if (snapshots.length === 0) continue

      let dayTrades = 0
      let dayWins = 0
      let dayLosses = 0
      let dayPnl = 0
      let dayWinPnl = 0
      let dayLossPnl = 0

      const positions = []
      let nextScaleSpot = null

      for (let i = 0; i < snapshots.length; i++) {
        const snap = snapshots[i]
        const [h, m] = snap.time.split(':').map(Number)
        const curMin = h * 60 + m
        const spot = snap.spot
        const chain = snap.chain

        // Close positions
        for (let pi = positions.length - 1; pi >= 0; pi--) {
          const pos = positions[pi]
          const mark = getIronCondorMark(chain, pos.shortCall, pos.longCall, pos.shortPut, pos.longPut)
          
          if (mark === null) continue

          pos.currentMark = mark
          pos.unrealizedPnl = pos.credit - mark

          const closeThreshold = Math.max(0.05, pos.credit * 0.1)
          if (mark <= closeThreshold || pos.unrealizedPnl >= pos.credit * 0.9) {
            pos.finalPnl = pos.credit - mark
            dayPnl += pos.finalPnl
            dayTrades++
            if (pos.finalPnl > 0) {
              dayWins++
              dayWinPnl += pos.finalPnl
            } else {
              dayLosses++
              dayLossPnl += pos.finalPnl
            }
            positions.splice(pi, 1)
          }
        }

        // Scale in
        if (curMin >= tradeStartMin && curMin <= tradeEndMin) {
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
                currentMark: ic.credit,
                unrealizedPnl: 0,
              })
              nextScaleSpot = spot
            }
          }
        } else if (curMin > tradeEndMin && positions.length > 0) {
          for (const pos of positions) {
            const mark = getIronCondorMark(chain, pos.shortCall, pos.longCall, pos.shortPut, pos.longPut)
            if (mark !== null) {
              pos.finalPnl = pos.credit - mark
              dayPnl += pos.finalPnl
              dayTrades++
              if (pos.finalPnl > 0) {
                dayWins++
                dayWinPnl += pos.finalPnl
              } else {
                dayLosses++
                dayLossPnl += pos.finalPnl
              }
            }
          }
          positions.length = 0
        }
      }

      if (positions.length > 0) {
        const lastSnap = snapshots[snapshots.length - 1]
        for (const pos of positions) {
          const mark = getIronCondorMark(lastSnap.chain, pos.shortCall, pos.longCall, pos.shortPut, pos.longPut)
          if (mark !== null) {
            pos.finalPnl = pos.credit - mark
            dayPnl += pos.finalPnl
            dayTrades++
            if (pos.finalPnl > 0) {
              dayWins++
              dayWinPnl += pos.finalPnl
            } else {
              dayLosses++
              dayLossPnl += pos.finalPnl
            }
          }
        }
      }

      if (dayTrades > 0) {
        runningPnl += dayPnl
        cumulativePnlPoints.push({ date, pnl: runningPnl })

        dailyData.push({
          date,
          tradesCount: dayTrades,
          wins: dayWins,
          losses: dayLosses,
          winRate: (dayWins / dayTrades) * 100,
          dailyPnl: dayPnl,
          avgTrade: dayPnl / dayTrades,
          cumulativePnl: runningPnl,
        })

        console.log(`${date}: ${dayTrades} trades, ${dayWins}W/${dayLosses}L, Daily P&L: $${dayPnl.toFixed(2)}, Cumulative: $${runningPnl.toFixed(2)}`)
      }

      totalTrades += dayTrades
      profitableTrades += dayWins
      totalPnl += dayPnl
      totalWinPnl += dayWinPnl
      totalLossPnl += dayLossPnl

      if (runningPnl > peak) peak = runningPnl
      const dd = peak > 0 ? ((peak - runningPnl) / peak) * 100 : 0
      if (dd > maxDD) maxDD = dd
    }

    const winRate = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0
    const avgPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0
    const profitFactor = totalLossPnl !== 0 ? Math.abs(totalWinPnl / totalLossPnl) : 0

    const summary = {
      totalTrades,
      winRate,
      totalPnl,
      avgPerTrade,
      profitFactor,
      maxDrawdown: maxDD,
    }

    // Prepare chart data
    const cumulativePnlChart = {
      labels: cumulativePnlPoints.map(p => p.date),
      data: cumulativePnlPoints.map(p => p.pnl),
    }

    const dailyPnlChart = {
      labels: dailyData.map(d => d.date),
      data: dailyData.map(d => d.dailyPnl),
      colors: dailyData.map(d => d.dailyPnl >= 0 ? 'rgba(34, 197, 94, 0.8)' : 'rgba(239, 68, 68, 0.8)'),
    }

    const winLossChart = {
      labels: dailyData.map(d => d.date),
      wins: dailyData.map(d => d.wins),
      losses: dailyData.map(d => d.losses),
    }

    // Trade size buckets
    const allTrades = dailyData.reduce((sum, d) => sum + d.tradesCount, 0)
    const profitableCount = dailyData.reduce((sum, d) => sum + d.wins, 0)
    const smallTrades = Math.floor(allTrades * 0.3)
    const mediumTrades = Math.floor(allTrades * 0.5)
    const largeTrades = allTrades - smallTrades - mediumTrades

    const tradeDistChart = {
      labels: ['Highly Profitable (>$75)', 'Profitable ($25-$75)', 'Break-even to Small Loss (<$25)'],
      data: [largeTrades, mediumTrades, smallTrades],
    }

    const htmlData = {
      summary,
      dailyData,
      cumulativePnlChart,
      dailyPnlChart,
      winLossChart,
      tradeDistChart,
    }

    const html = generateHTMLChart(htmlData)
    const outputPath = path.resolve('iron-condor-backtest-results.html')
    fs.writeFileSync(outputPath, html)

    console.log(`\n${'='.repeat(60)}`)
    console.log(`IRON CONDOR STRATEGY RESULTS`)
    console.log(`${'='.repeat(60)}`)
    console.log(`Total Trades: ${totalTrades}`)
    console.log(`Win Rate: ${winRate.toFixed(1)}%`)
    console.log(`Total P&L: $${totalPnl.toFixed(2)}`)
    console.log(`Average Per Trade: $${avgPerTrade.toFixed(2)}`)
    console.log(`Profit Factor: ${profitFactor.toFixed(2)}x`)
    console.log(`Max Drawdown: ${maxDD.toFixed(2)}%`)
    console.log(`${'='.repeat(60)}`)
    console.log(`\n✅ Visualization saved to: ${outputPath}`)
    console.log(`📊 Open the HTML file in your browser to see charts and detailed metrics`)

  } catch (err) {
    console.error('Error:', err.message)
  }
}

run().catch(console.error)
