import { listDateDirs, loadDateParquet } from './data-loader.js';

const dates = await listDateDirs();
console.log('Available dates:');
dates.forEach(d => console.log(' ', d.name));
console.log('Total:', dates.length);

if (dates.length > 0) {
  const date = dates[0].name;
  console.log(`\nLoading ${date}...`);
  const rows = await loadDateParquet(date);
  console.log(`Loaded ${rows.length} rows`);
  if (rows.length > 0) {
    const first = rows[0];
    console.log('First row keys:', Object.keys(first).length);
    const interesting = ['option_code', 'option', 'S', 'K', 'bid', 'ask', 'mid', 'last', 'bsiv', 'delta', 'gamma', 'theta', 'vega', 'open_int', 'volume', 't', 'dte', 'exp', 'date', 'low', 'high', 'change'];
    for (const k of interesting) {
      if (k in first) {
        const v = first[k];
        console.log(`  ${k}: ${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v).slice(0, 30)}`);
      }
    }
    const spxw = rows.filter(r => r.option_code && String(r.option_code).includes('SPXW240603') && r.option === 'call');
    console.log(`\n0DTE calls (SPXW240603): ${spxw.length} strikes`);
    if (spxw.length > 0) {
      spxw.slice(0, 5).forEach(r => console.log(`  K=${r.K} mid=${r.mid} bid=${r.bid} ask=${r.ask} iv=${r.bsiv?.toFixed(4)} delta=${r.delta?.toFixed(4)}`));
    }
  }
}
