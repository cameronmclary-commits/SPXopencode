import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { listSessions, loadDateParquet, warmCache, fetchAvailableDates } from './data-loader.js';
import * as ibkr from './ibkr-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, '..', 'spx-app', 'dist');

const app = express();
const PORT = process.env.PORT || 3080;

app.use(cors());

app.use(express.static(STATIC_DIR));

let sessionList = listSessions();

// Fetch available dates from GitHub on startup
fetchAvailableDates().then(dates => {
  sessionList = listSessions();
  console.log(`Loaded ${sessionList.length} available dates`);
});

function buildSessionFromRows(rows, dateStr) {
  if (!rows || rows.length === 0) return null;

  const spotPrice = rows[0].S || 0;
  const todayCode = 'SPXW' + dateStr.slice(2, 4) + dateStr.slice(5, 7) + dateStr.slice(8, 10);

  const zeroDteRows = rows.filter(r =>
    r.option_code && String(r.option_code).startsWith(todayCode)
  );

  const sourceRows = zeroDteRows.length > 0 ? zeroDteRows : rows;

  const chain = [];
  for (const r of sourceRows) {
    if (!r.K || !r.option) continue;
    chain.push({
      strike: r.K,
      type: r.option === 'call' ? 'call' : 'put',
      bid: r.bid || 0,
      ask: r.ask || 0,
      last: r.last || r.mid || 0,
      mid: r.mid || 0,
      volume: r.volume || 0,
      openInterest: r.open_int || 0,
      delta: r.bsdelta != null ? Math.round(r.bsdelta * 1000) / 1000 : undefined,
      gamma: r.bsgamma != null ? Math.round(r.bsgamma * 10000) / 10000 : undefined,
      theta: r.bstheta != null ? Math.round(r.bstheta * 100) / 100 : undefined,
      vega: r.bs_vega != null ? Math.round(r.bs_vega * 1000) / 1000 : undefined,
      iv: r.bsiv != null ? Math.round(r.bsiv * 10000) / 10000 : undefined,
    });
  }

  chain.sort((a, b) => a.strike - b.strike);

  const ds = rows[0]?.ds || 0;
  const open = spotPrice - ds;
  const close = spotPrice;

  const calls = rows.filter(r => r.option === 'call' && r.K);
  calls.sort((a, b) => Math.abs(a.K - spotPrice) - Math.abs(b.K - spotPrice));
  const atmCall = calls[0];

  let low, high;
  if (atmCall && atmCall.low && atmCall.high && atmCall.high > atmCall.low) {
    const optionRange = atmCall.high - atmCall.low;
    const estimatedMove = optionRange * 2;
    low = spotPrice - estimatedMove / 2;
    high = spotPrice + estimatedMove / 2;
  } else {
    low = Math.min(open, close);
    high = Math.max(open, close);
  }

  const pricePath = [];
  const steps = 78;
  const controlPoints = [
    { t: 0, v: spotPrice },
    { t: 0.2, v: high },
    { t: 0.65, v: low },
    { t: 1, v: close },
  ]
  for (let i = 0; i <= steps; i++) {
    const pct = i / steps;
    const hours = 9.5 + pct * 6.5;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    const time = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

    let seg = 0
    for (let j = 0; j < controlPoints.length - 1; j++) {
      if (pct >= controlPoints[j].t && pct <= controlPoints[j + 1].t) { seg = j; break }
    }
    const cp0 = controlPoints[seg], cp1 = controlPoints[seg + 1]
    const localT = (pct - cp0.t) / (cp1.t - cp0.t)
    const smoothT = localT * localT * (3 - 2 * localT)
    const price = cp0.v + (cp1.v - cp0.v) * smoothT;
    pricePath.push({ time, price: Math.round(price * 100) / 100 });
  }

  return {
    id: dateStr.replace(/-/g, ''),
    date: dateStr,
    spotPrice,
    pricePath,
    openingChain: chain,
    chainSize: chain.length,
    hasZeroDte: zeroDteRows.length > 0,
    dailyLow: low,
    dailyHigh: high,
    dailyClose: close,
    dailyChange: ds,
  };
}

app.get('/api/sessions', (req, res) => {
  const list = sessionList.map(s => ({
    id: s.id,
    date: s.date,
  }));
  res.json({ sessions: list, total: list.length });
});

app.get('/api/sessions/:date', async (req, res) => {
  try {
    const { date } = req.params;
    if (!sessionList.some(s => s.date === date)) {
      return res.status(404).json({ error: 'Date not found' });
    }
    const rows = await loadDateParquet(date);
    const session = buildSessionFromRows(rows, date);
    if (!session) return res.status(404).json({ error: 'No data for ' + date });
    res.json(session);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chain/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const rows = await loadDateParquet(date);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'No data for ' + date });
    }
    const spotPrice = rows[0].S || 0;
    const chain = rows
      .filter(r => r.K && r.option)
      .map(r => ({
        strike: r.K,
        type: r.option === 'call' ? 'call' : 'put',
        bid: r.bid || 0,
        ask: r.ask || 0,
        mid: r.mid || 0,
        last: r.last || r.mid || 0,
        volume: r.volume || 0,
        openInterest: r.open_int || 0,
      }));
    res.json({ date, spotPrice, chainSize: chain.length, chain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:date/snapshots', async (req, res) => {
  try {
    const { date } = req.params;
    const rows = await loadDateParquet(date);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'No data for ' + date });
    }

    const session = buildSessionFromRows(rows, date);
    if (!session) return res.status(404).json({ error: 'No data for ' + date });

    const spotPrice = rows[0].S || 0;
    const ds = rows[0]?.ds || 0;

    const chain = rows
      .filter(r => r.K && r.option)
      .map(r => ({
        strike: r.K,
        type: r.option === 'call' ? 'call' : 'put',
        bid: r.bid || 0,
        ask: r.ask || 0,
        mid: r.mid || 0,
        last: r.last || r.mid || 0,
        volume: r.volume || 0,
        openInterest: r.open_int || 0,
        delta: r.bsdelta != null ? Math.round(r.bsdelta * 1000) / 1000 : undefined,
        gamma: r.bsgamma != null ? Math.round(r.bsgamma * 10000) / 10000 : undefined,
        theta: r.bstheta != null ? Math.round(r.bstheta * 100) / 100 : undefined,
        vega: r.bs_vega != null ? Math.round(r.bs_vega * 1000) / 1000 : undefined,
        iv: r.bsiv != null ? Math.round(r.bsiv * 10000) / 10000 : undefined,
      }));

    const snapshots = session.pricePath.map(p => ({
      time: p.time,
      spot: p.price,
      chain: chain,
    }));

    res.json({ snapshots, dailyChange: ds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let liveData = { chain: null, spot: 0, pricePath: [], startTime: Date.now() }
let liveActive = false

app.get('/api/live/status', async (req, res) => {
  const status = await ibkr.isAvailable()
  res.json({ ...status, active: liveActive, chainSize: liveData.chain?.chain?.length || 0, spot: liveData.spot })
})

app.get('/api/live/chain', (req, res) => {
  if (!liveActive || !liveData.chain) return res.status(503).json({ error: 'Live feed not active' })
  res.json(liveData.chain)
})

app.get('/api/live/spot', (req, res) => {
  res.json({ spot: liveData.spot, pricePath: liveData.pricePath, uptime: Date.now() - liveData.startTime })
})

app.get('/api/live/accounts', async (req, res) => {
  try {
    const accounts = await ibkr.getAccounts()
    res.json(accounts)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/live/order', express.json(), async (req, res) => {
  try {
    const { accountId, action, quantity, orderType, price, conid } = req.body
    if (!accountId || !action || !quantity) {
      return res.status(400).json({ error: 'Missing required fields: accountId, action, quantity' })
    }
    const result = await ibkr.placeOrder(accountId, { conid }, action, quantity, orderType, price)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

async function startLiveFeed() {
  const status = await ibkr.isAvailable()
  if (!status.connected || !status.authenticated) return

  liveActive = true
  console.log('Live IBKR feed started')

  ibkr.startLiveFeed(
    (chain) => {
      liveData.chain = chain
      liveData.spot = chain.spotPrice
      liveData.pricePath.push({ time: new Date().toISOString(), price: chain.spotPrice })
      if (liveData.pricePath.length > 5000) liveData.pricePath = liveData.pricePath.slice(-5000)
    },
    (spot) => {
      liveData.spot = spot
      liveData.pricePath.push({ time: new Date().toISOString(), price: spot })
      if (liveData.pricePath.length > 5000) liveData.pricePath = liveData.pricePath.slice(-5000)
    },
    (err) => console.error('Live feed error:', err),
  )
}

if (process.env.IB_LIVE === 'true') {
  startLiveFeed().catch(err => console.error('Failed to start live feed:', err))
}

let cacheProgress = { cached: 0, total: sessionList.length, ok: 0 };

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', datesAvailable: sessionList.length, cache: cacheProgress });
});

app.use((req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log('Options Data API running on http://localhost:' + PORT);
  console.log('Available dates: ' + sessionList.length);

  warmCache((done, total, ok) => {
    cacheProgress = { cached: done, total, ok };
    const pct = ((done / total) * 100).toFixed(0);
    process.stdout.write(`\rCache warm: ${done}/${total} (${pct}%) — ${ok} ok`);
    if (done >= total) process.stdout.write('\n');
  });
});
