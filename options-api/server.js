import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { listSessions, loadDateParquet } from './data-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, '..', 'spx-app', 'dist');

const app = express();
const PORT = process.env.PORT || 3080;

app.use(cors());

app.use(express.static(STATIC_DIR));

const sessionList = listSessions();

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
    });
  }

  chain.sort((a, b) => a.strike - b.strike);

  const low = rows.reduce((min, r) => r.low != null && r.low < min ? r.low : min, spotPrice);
  const high = rows.reduce((max, r) => r.high != null && r.high > max ? r.high : max, spotPrice);
  const close = spotPrice + (rows[0]?.change || 0);

  const pricePath = [];
  const steps = 78;
  for (let i = 0; i <= steps; i++) {
    const pct = i / steps;
    const hours = 9.5 + pct * 6.5;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    const time = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

    let price;
    if (pct < 0.3) {
      const t = pct / 0.3;
      price = spotPrice + (high - spotPrice) * Math.sin(t * Math.PI / 2);
    } else if (pct < 0.7) {
      const t = (pct - 0.3) / 0.4;
      price = high - (high - low) * t;
    } else {
      const t = (pct - 0.7) / 0.3;
      price = low + (close - low) * (1 - Math.cos(t * Math.PI / 2));
    }
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
