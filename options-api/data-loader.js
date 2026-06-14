import fs from 'fs';
import path from 'path';
import { parquetRead, parquetMetadata } from 'hyparquet';

const RAW_BASE = 'https://raw.githubusercontent.com/gar-c/OptionData/main/Options_Data';
const CACHE_DIR = path.join(process.cwd(), '.cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let KNOWN_DATES = [];

export async function fetchAvailableDates() {
  try {
    const res = await fetch('https://api.github.com/repos/gar-c/OptionData/contents/Options_Data');
    if (!res.ok) return KNOWN_DATES;
    const data = await res.json();
    if (!Array.isArray(data)) return KNOWN_DATES;
    KNOWN_DATES = data
      .filter(d => d.type === 'dir' && d.name.startsWith('date='))
      .map(d => d.name.replace('date=', ''))
      .sort();
    return KNOWN_DATES;
  } catch {
    return KNOWN_DATES;
  }
}

export function getKnownDates() {
  return KNOWN_DATES;
}

export function listSessions() {
  return KNOWN_DATES.map(d => ({
    date: d,
    id: d.replace(/-/g, ''),
    sessionDate: d,
  }));
}

function dateToPartCodes(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const y = String(d.getFullYear()).slice(2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  const expirations = [];

  const today = `${y}${m}${day}`;
  expirations.push({ code: `SPXW${today}`, type: '0DTE' });

  const nextFri = getNextExpiration(d, 5);
  expirations.push({ code: `SPXW${nextFri}`, type: 'weekly' });

  const nextMonExpiry = getNextExpiration(d, 3);
  if (nextMonExpiry !== today) {
    expirations.push({ code: `SPXW${nextMonExpiry}`, type: 'weekly' });
  }

  return expirations;
}

function getNextExpiration(date, dayOfWeek) {
  const d = new Date(date);
  const currentDay = d.getDay();
  let diff = dayOfWeek - currentDay;
  if (diff <= 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return String(d.getFullYear()).slice(2) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
}

function buildParquetUrl(dateStr, partCode) {
  return `${RAW_BASE}/date=${dateStr}/part=${partCode}/part-0.parquet`;
}

async function downloadParquet(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'options-api' } });
  if (!res.ok) return null;
  return res.arrayBuffer();
}

function rowToObject(row, columns) {
  const obj = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = row[i];
  }
  return obj;
}

export async function warmCache(onProgress) {
  const BATCH_SIZE = 5;
  for (let i = 0; i < KNOWN_DATES.length; i += BATCH_SIZE) {
    const batch = KNOWN_DATES.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(d => loadDateParquet(d)));
    const done = Math.min(i + BATCH_SIZE, KNOWN_DATES.length);
    const ok = results.filter(r => r.status === 'fulfilled').length;
    onProgress?.(done, KNOWN_DATES.length, ok);
  }
}

export async function loadDateParquet(dateStr) {
  const cachePath = path.join(CACHE_DIR, `${dateStr}.json`);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }

  const parts = dateToPartCodes(dateStr);
  let allRows = [];

  for (const part of parts) {
    const url = buildParquetUrl(dateStr, part.code);
    const buf = await downloadParquet(url);
    if (!buf) continue;

    const meta = await parquetMetadata(buf);
    const columns = meta.schema.filter(s => !s.num_children).map(s => s.name);

    await new Promise((resolve) => {
      parquetRead({
        file: buf,
        onComplete: (data) => {
          const rows = data.map(r => rowToObject(r, columns));
          allRows = allRows.concat(rows);
          resolve();
        },
      });
    });
  }

  fs.writeFileSync(cachePath, JSON.stringify(allRows));
  return allRows;
}
