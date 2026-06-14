import { listSessions, loadDateParquet } from './data-loader.js';
import { buildSessionFromRows } from './server.js';

const sessions = listSessions();
console.log(`Total sessions available: ${sessions.length}`);
console.log(`First: ${sessions[0].date}, Last: ${sessions[sessions.length - 1].date}`);

// Test loading one session
console.log('\nLoading 2024-06-03...');
const rows = await loadDateParquet('2024-06-03');
console.log(`Loaded ${rows.length} rows`);

// Check what expirations are available
const expirations = new Set();
rows.forEach(r => {
  if (r.exp) expirations.add(r.exp);
});
console.log('Expirations found:', Array.from(expirations).sort());

// Check 0DTE chain
const todayCode = 'SPXW240603';
const zeroDte = rows.filter(r => r.option_code && String(r.option_code).includes(todayCode));
console.log(`\n0DTE options (${todayCode}): ${zeroDte.length} rows`);
const calls = zeroDte.filter(r => r.option === 'call');
const puts = zeroDte.filter(r => r.option === 'put');
console.log(`  Calls: ${calls.length}, Puts: ${puts.length}`);
console.log(`  Spot: ${rows[0].S}`);

// Show a few calls
console.log('\nSample calls near ATM:');
const atmCalls = calls
  .filter(r => Math.abs(r.K - rows[0].S) < 100)
  .sort((a, b) => a.K - b.K);
atmCalls.slice(0, 5).forEach(r => {
  console.log(`  K=${r.K} bid=${r.bid} ask=${r.ask} mid=${r.mid} iv=${r.bsiv?.toFixed(4)} delta=${(r.delta || r.bsdelta)?.toFixed(4)} oi=${r.open_int}`);
});

console.log('\nSample puts near ATM:');
const atmPuts = puts
  .filter(r => Math.abs(r.K - rows[0].S) < 100)
  .sort((a, b) => a.K - b.K);
atmPuts.slice(0, 5).forEach(r => {
  console.log(`  K=${r.K} bid=${r.bid} ask=${r.ask} mid=${r.mid} iv=${r.bsiv?.toFixed(4)} delta=${(r.delta || r.bsdelta)?.toFixed(4)} oi=${r.open_int}`);
});
