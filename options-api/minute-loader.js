import fs from 'fs';
import path from 'path';
import { decompress } from '@mongodb-js/zstd';

const OPRA_DIR = '/var/folders/n6/dnlkyxhx3gd736skth2hlt880000gp/T/opencode/opra_data';
const CACHE_DIR = path.join(OPRA_DIR, '..', 'snapshot-cache');

function parseSymbol(symbol) {
  const expStr = symbol.substring(6, 12);
  const type = symbol[12] === 'C' ? 'call' : 'put';
  const strike = parseInt(symbol.substring(13, 21)) / 1000;
  return { expStr, type, strike };
}

function findLastComma(buf, end) {
  for (let i = end; i >= 0; i--) if (buf[i] === 44) return i;
  return -1;
}

const _opraDates = (() => {
  try {
    return fs.readdirSync(OPRA_DIR)
      .filter(f => f.startsWith('opra-pillar-'))
      .map(f => {
        const y = f.substring(12, 16), m = f.substring(16, 18), d = f.substring(18, 20);
        return `${y}-${m}-${d}`;
      });
  } catch (e) {
    return [];
  }
})();

export function getOpraDates() {
  return [..._opraDates];
}

export async function loadMinuteSnapshots(dateStr) {
  const parts = dateStr.split('-');
  const fileDate = parts[0] + parts[1] + parts[2];
  const fileDateShort = fileDate.slice(2);
  const fname = `opra-pillar-${fileDate}.cbbo-1m.csv.zst`;
  const fpath = path.join(OPRA_DIR, fname);

  if (!fs.existsSync(fpath)) return null;

  // Check cache
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${fileDateShort}.json`);

  if (fs.existsSync(cachePath)) {
    const cached = fs.readFileSync(cachePath, 'utf-8');
    return JSON.parse(cached);
  }

  // Parse zst file
  const compressed = fs.readFileSync(fpath);
  const dec = await decompress(compressed);

  const snapshots = new Map();
  let lineStart = 0;
  let lineNum = 0;

  for (let i = 0; i < dec.length; i++) {
    if (dec[i] !== 10) continue;
    if (lineNum === 0) { lineStart = i + 1; lineNum++; continue; }

    const line = dec.slice(lineStart, i);
    lineStart = i + 1;
    lineNum++;

    // Quick symbol check: last field after last comma
    const lastComma = findLastComma(line, line.length - 1);
    if (lastComma < 0) continue;
    const symbol = line.slice(lastComma + 1).toString();
    if (symbol.length < 15 || symbol[0] !== 'S' || symbol[1] !== 'P') continue;

    const { expStr, type, strike } = parseSymbol(symbol);
    if (expStr !== fileDateShort) continue;

    // Parse comma-separated fields in one pass (we only need cols 0, 9, 10, 13, 14)
    const fields = [];
    let fStart = 0;
    for (let j = 0; j <= line.length; j++) {
      if (j === line.length || line[j] === 44) {
        if (fields.length <= 15) fields.push(line.slice(fStart, j).toString());
        fStart = j + 1;
        if (fields.length === 16) break;
      }
    }
    if (fields.length < 16) continue;

    const minuteKey = fields[0].slice(0, 16);
    if (minuteKey.length < 16) continue;

    let bid = parseFloat(fields[9]);
    let ask = parseFloat(fields[10]);

    if (!(bid > 0 && ask > 0)) {
      const b = parseFloat(fields[13]);
      const a = parseFloat(fields[14]);
      if (b > 0 && a > 0) { bid = b; ask = a; }
    }
    if (!(bid > 0 && ask > 0)) continue;

    let snap = snapshots.get(minuteKey);
    if (!snap) {
      snap = { time: minuteKey, spot: 0, chain: [] };
      snapshots.set(minuteKey, snap);
    }

    snap.chain.push({ strike, type, bid: Math.round(bid * 10000) / 10000, ask: Math.round(ask * 10000) / 10000 });
  }

  const result = [];
  for (const snap of snapshots.values()) {
    const calls = snap.chain.filter(r => r.type === 'call').sort((a, b) => a.strike - b.strike);
    const puts = snap.chain.filter(r => r.type === 'put').sort((a, b) => a.strike - b.strike);

    const estSpots = [];
    let ci = 0, pi = 0;
    while (ci < calls.length && pi < puts.length) {
      const c = calls[ci], p = puts[pi];
      if (c.strike === p.strike) {
        const midC = (c.bid + c.ask) / 2;
        const midP = (p.bid + p.ask) / 2;
        if (midC > 0 && midP > 0) estSpots.push(c.strike + midC - midP);
        ci++; pi++;
      } else if (c.strike < p.strike) { ci++; } else { pi++; }
    }

    if (estSpots.length > 0) {
      estSpots.sort((a, b) => a - b);
      snap.spot = Math.round(estSpots[Math.floor(estSpots.length / 2)] * 100) / 100;
    }

    snap.chain = snap.chain
      .map(r => ({
        strike: r.strike, type: r.type,
        bid: r.bid, ask: r.ask,
        mid: Math.round(((r.bid + r.ask) / 2) * 10000) / 10000,
        last: 0, volume: 0, openInterest: 0,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'call' ? -1 : 1;
        return a.strike - b.strike;
      });

    result.push(snap);
  }

  // Keep only strikes within ±400 pts of estimated spot
  for (const snap of result) {
    if (snap.spot > 0) {
      snap.chain = snap.chain.filter(r => Math.abs(r.strike - snap.spot) <= 40);
    }
  }

  result.sort((a, b) => a.time.localeCompare(b.time));

  // Write cache
  fs.writeFileSync(cachePath, JSON.stringify(result));
  console.log(`Cached ${result.length} snapshots for ${dateStr}`);

  return result;
}
