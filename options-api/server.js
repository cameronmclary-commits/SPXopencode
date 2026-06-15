import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadMinuteSnapshots, getOpraDates } from './minute-loader.js';
import * as ibkr from './ibkr-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, '..', 'spx-app', 'dist');

const app = express();
const PORT = process.env.PORT || 3080;

app.use(cors());
app.use(express.static(STATIC_DIR));

const opraDates = getOpraDates();
const sessionList = opraDates.map(d => ({ date: d, id: d.replace(/-/g, ''), sessionDate: d }));
console.log(`Loaded ${sessionList.length} OPRA dates`);

app.get('/api/sessions', (req, res) => {
  const list = sessionList.map(s => ({
    id: s.id,
    date: s.date,
    hasSnapshots: true,
  }));
  res.json({ sessions: list, total: list.length });
});

app.get('/api/sessions/:date', async (req, res) => {
  try {
    const { date } = req.params;
    if (!sessionList.some(s => s.date === date)) {
      return res.status(404).json({ error: 'Date not found' });
    }

    const minutes = await loadMinuteSnapshots(date);
    if (!minutes || minutes.length === 0) {
      return res.status(404).json({ error: 'No OPRA data for ' + date });
    }

    const first = minutes[0];
    const spotPrice = first.spot;
    const pricePath = minutes
      .filter(m => m.spot > 0)
      .map(m => {
        const t = new Date(m.time + 'Z');
        const h = (t.getUTCHours() - 4 + 24) % 24;
        const min = t.getUTCMinutes();
        return { time: String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0'), price: m.spot };
      });

    res.json({
      id: date.replace(/-/g, ''),
      date,
      spotPrice,
      pricePath,
      openingChain: first.chain,
      chainSize: first.chain.length,
      hasZeroDte: true,
      dailyLow: Math.min(...pricePath.map(p => p.price)),
      dailyHigh: Math.max(...pricePath.map(p => p.price)),
      dailyClose: pricePath[pricePath.length - 1].price,
      dailyChange: Math.round((pricePath[pricePath.length - 1].price - spotPrice) * 100) / 100,
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chain/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const minutes = await loadMinuteSnapshots(date);
    if (!minutes || minutes.length === 0) {
      return res.status(404).json({ error: 'No OPRA data for ' + date });
    }
    const first = minutes[0];
    res.json({ date, spotPrice: first.spot, chainSize: first.chain.length, chain: first.chain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:date/snapshots', async (req, res) => {
  try {
    const { date } = req.params;
    const minutes = await loadMinuteSnapshots(date);
    if (!minutes || minutes.length === 0) {
      return res.status(404).json({ error: 'No OPRA data for ' + date });
    }

    const snapshots = minutes.filter(m => m.spot > 0).map(m => {
      const dt = new Date(m.time + 'Z');
      const etHour = (dt.getUTCHours() - 4 + 24) % 24;
      const etMin = dt.getUTCMinutes();
      const time = String(etHour).padStart(2, '0') + ':' + String(etMin).padStart(2, '0');
      return { time, spot: m.spot, chain: m.chain };
    });

    res.json({ snapshots, dailyChange: 0 });
  } catch (err) {
    console.error('Snapshots error:', err);
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', datesAvailable: sessionList.length });
});

app.use((req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log('Options Data API running on http://localhost:' + PORT);
  console.log('Available dates: ' + sessionList.length);
});
