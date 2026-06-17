import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import process from 'process';
import fs from 'fs';
import * as ibkr from './ibkr-client.js';
import { fetchLiveSession, listSessions, loadSession } from './yahoo-provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, '..', 'spx-app', 'dist');
const CACHE_DIR = path.resolve(__dirname, '..', 'snapshot-cache');

const app = express();
const PORT = process.env.PORT || 3080;

app.use(cors());
app.use(express.static(STATIC_DIR));

function loadSnapshots(dateStr) {
  const fileDate = dateStr.slice(2).replace(/-/g, '');
  const cachePath = path.join(CACHE_DIR, `${fileDate}.json`);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
  try {
    const script = path.resolve(__dirname, 'fetch_spxw_snapshots.py');
    const out = execSync(`python3 "${script}" "${dateStr}"`, {
      encoding: 'utf-8', timeout: 120000,
      env: { ...process.env, DATABENTO_API_KEY: process.env.DATABENTO_API_KEY || '' },
    });
    return JSON.parse(out);
  } catch (e) {
    console.error(`Databento fetch failed for ${dateStr}:`, e.message);
    return null;
  }
}

function listCachedDates() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return [];
    return fs.readdirSync(CACHE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const raw = f.replace('.json', '');
        return `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`;
      })
      .sort();
  } catch { return []; }
}

const sessionList = listCachedDates().map(d => ({ date: d, id: d.replace(/-/g, ''), sessionDate: d }));

app.get('/api/sessions', (req, res) => {
  const dates = listCachedDates().map(d => ({
    id: d.replace(/-/g, ''),
    date: d,
    hasSnapshots: true,
  }));
  res.json({ sessions: dates, total: dates.length });
});

app.get('/api/sessions/:date', async (req, res) => {
  try {
    const { date } = req.params;

    const minutes = loadSnapshots(date);
    if (!minutes || minutes.length === 0) {
      return res.status(404).json({ error: 'No data for ' + date });
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
    const minutes = loadSnapshots(date);
    if (!minutes || minutes.length === 0) {
      return res.status(404).json({ error: 'No data for ' + date });
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
    const minutes = loadSnapshots(date);
    if (!minutes || minutes.length === 0) {
      return res.status(404).json({ error: 'No data for ' + date });
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

app.get('/api/live/yahoo', async (req, res) => {
  try {
    const data = await fetchLiveSession();
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.get('/api/live/sessions', (req, res) => {
  try {
    res.json(listSessions());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live/session/:date', (req, res) => {
  try {
    const data = loadSession(req.params.date);
    if (!data) return res.status(404).json({ error: 'Session not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log('Options Data API running on http://localhost:' + PORT);
});
