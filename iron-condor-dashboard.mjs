import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_BASE = 'http://localhost:3080'
const PORT = 4000
const HTML_PATH = path.join(__dirname, 'iron-condor-dashboard.html')

function proxyApi(req, res) {
  const target = API_BASE + req.url
  http.get(target, apiRes => {
    res.writeHead(apiRes.statusCode, apiRes.headers)
    apiRes.pipe(res)
  }).on('error', err => {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Could not reach options-api at ${API_BASE}`, detail: err.message }))
  })
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    proxyApi(req, res)
    return
  }
  fs.readFile(HTML_PATH, (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`Could not read ${HTML_PATH}: ${err.message}`)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
})

server.listen(PORT, () => {
  console.log(`Iron Condor dashboard:  http://localhost:${PORT}`)
  console.log(`Proxying /api/* to ${API_BASE} — make sure that's running too (cd options-api && npm start)`)
})
