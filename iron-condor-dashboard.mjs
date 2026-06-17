// serve.mjs — serves the dashboard + canonical engine module, and provides /api.
//
//   node serve.mjs            -> uses built-in SYNTHETIC demo data (no options-api needed)
//   REAL_API=1 node serve.mjs -> proxies /api/* to the real options-api on :3080
//
// Open http://localhost:4000
import http from 'http'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const DIR = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 4000
const REAL = process.env.REAL_API === '1'
const UPSTREAM = 'http://localhost:3080'

// ---- synthetic data: a few trending sessions whose chains only quote a band ----
// near the current spot, so old flies' strikes drift out of band on big moves.
function pad(n) { return String(n).padStart(2, '0') }
function quote(strike, type, spot) {
  const intr = type === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot)
  const extr = Math.max(0.4, 14 - Math.abs(spot - strike) * 0.32)
  const mid = intr + extr
  return { strike, type, bid: +(mid - 0.35).toFixed(2), ask: +(mid + 0.35).toFixed(2) }
}
function chainFor(spot) {
  const c = Math.round(spot / 5) * 5
  const rows = []
  for (let k = c - 45; k <= c + 45; k += 5) { rows.push(quote(k, 'call', spot)); rows.push(quote(k, 'put', spot)) }
  return rows
}
function makeSession(seed) {
  const path = []
  let p = 7400 + seed * 7
  const start = 9 * 60 + 31
  for (let i = 0; i < 40; i++) {
    const drift = Math.sin(i / 5 + seed) * 6 + (seed % 2 ? i * 0.9 : -i * 0.7)
    p = 7400 + seed * 7 + drift
    const mins = start + i * 9
    path.push({ time: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`, price: +p.toFixed(2) })
  }
  const snapshots = path.map(pt => ({ chain: chainFor(pt.price) }))
  return { pricePath: path, openingChain: snapshots[0].chain, snapshots }
}
const DATES = ['2026-06-10', '2026-06-12', '2026-06-16']
const SESSIONS = Object.fromEntries(DATES.map((d, i) => [d, makeSession(i + 1)]))

function sendJSON(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj))
}
function proxy(req, res) {
  http.get(UPSTREAM + req.url, up => { res.writeHead(up.statusCode, up.headers); up.pipe(res) })
    .on('error', () => { res.writeHead(502); res.end('options-api (:3080) not reachable') })
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  try {
    if (url === '/' || url === '/index.html') {
      const html = await readFile(join(DIR, 'iron-condor-dashboard.html'))
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html)
    }
    if (url === '/iron-condor-engine.mjs') {
      const js = await readFile(join(DIR, 'iron-condor-engine.mjs'))
      res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(js)
    }
    if (url.startsWith('/api/')) {
      if (REAL) return proxy(req, res)
      if (url === '/api/sessions') return sendJSON(res, { sessions: DATES.map(d => ({ date: d, hasSnapshots: true })) })
      const m = url.match(/^\/api\/sessions\/([^/]+)(\/snapshots)?$/)
      if (m) {
        const s = SESSIONS[m[1]]
        if (!s) { res.writeHead(404); return res.end('{}') }
        if (m[2]) return sendJSON(res, { snapshots: s.snapshots })
        return sendJSON(res, { pricePath: s.pricePath, openingChain: s.openingChain })
      }
      res.writeHead(404); return res.end('{}')
    }
    res.writeHead(404); res.end('not found')
  } catch (e) { res.writeHead(500); res.end(String(e)) }
})
server.listen(PORT, () => console.log(`dashboard on http://localhost:${PORT}  (${REAL ? 'proxying real :3080' : 'synthetic demo data'})`))
