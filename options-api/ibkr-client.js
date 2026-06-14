import https from 'node:https'
import fs from 'node:fs'

const GATEWAY_BASE = process.env.IB_GATEWAY_URL || 'https://localhost:5000/v1/api'
const SPX_CONID = 416904
const POLL_INTERVAL = Number(process.env.IB_POLL_INTERVAL) || 15_000

const agent = new https.Agent({ rejectUnauthorized: false })

async function api(path, options = {}) {
  const url = `${GATEWAY_BASE}${path}`
  const res = await fetch(url, {
    ...options,
    agent,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`IB Gateway ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

export async function isAvailable() {
  try {
    const data = await api('/iserver/auth/status')
    return { connected: true, authenticated: data.authenticated || false }
  } catch {
    return { connected: false, authenticated: false }
  }
}

export async function waitForAuth(timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await isAvailable()
    if (status.connected && status.authenticated) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

async function getSPXWContractDescription() {
  const today = new Date()
  const y = today.getFullYear().toString().slice(2)
  let m = (today.getMonth() + 1).toString().padStart(2, '0')
  let d = today.getDate().toString().padStart(2, '0')

  const expiry = `${y}${m}${d}`

  const body = {
    symbol: 'SPXW',
    secType: 'OPT',
    exchange: 'SMART',
    name: true,
    expiry,
  }

  const data = await api('/iserver/secdef/search', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!data || data.length === 0) {
    const bodyMonthly = { symbol: 'SPX', secType: 'OPT', exchange: 'SMART', name: true, expiry }
    const dataMonthly = await api('/iserver/secdef/search', {
      method: 'POST',
      body: JSON.stringify(bodyMonthly),
    })
    return dataMonthly || []
  }

  return data
}

function findWeeklyContracts(contracts, today) {
  const friday = new Date(today)
  const dow = friday.getDay()
  const diff = dow <= 1 ? 1 - dow : 6 - dow + 1
  friday.setDate(friday.getDate() + diff)

  if (dow === 5 && today.getHours() >= 16) {
    friday.setDate(friday.getDate() + 7)
  }

  const weekly = contracts.filter(c => {
    if (!c.expiry) return false
    const exp = c.expiry.toString()
    const m = parseInt(exp.slice(4, 6), 10)
    const d = parseInt(exp.slice(6, 8), 10)
    if (m !== friday.getMonth() + 1) return false
    return Math.abs(d - friday.getDate()) <= 1
  })

  return weekly.length > 0 ? weekly : contracts.filter(c => {
    if (!c.expiry) return false
    const exp = c.expiry.toString()
    const m = parseInt(exp.slice(4, 6), 10)
    const d = parseInt(exp.slice(6, 8), 10)
    return m === today.getMonth() + 1 || m === (today.getMonth() + 2) % 12 || m === (today.getMonth() + 12) % 12 + 1
  }).slice(0, 200)
}

export async function getOptionChain() {
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)

  const contracts = await getSPXWContractDescription()
  if (!contracts || contracts.length === 0) return { date: todayStr, spotPrice: 0, chainSize: 0, chain: [], contracts: [] }

  const weeklyContracts = findWeeklyContracts(contracts, today)

  const conids = weeklyContracts.map(c => c.conid).filter(Boolean)

  const chain = []
  for (let i = 0; i < conids.length; i += 50) {
    const batch = conids.slice(i, i + 50)
    try {
      const snapshots = await api('/iserver/marketdata/snapshot', {
        method: 'POST',
        body: JSON.stringify({ conids: batch, fields: ['31', '84', '85', '86', '70', '71'] }),
      })
      for (const snap of snapshots || []) {
        const contract = weeklyContracts.find(c => c.conid === Number(snap.conid))
        if (!contract) continue
        const bid = parseFloat(snap['84']?.v) || 0
        const ask = parseFloat(snap['86']?.v) || 0
        const last = parseFloat(snap['31']?.v) || 0
        if (bid === 0 && ask === 0 && last === 0) continue
        chain.push({
          strike: contract.strike || 0,
          type: contract.right?.toLowerCase() === 'c' ? 'call' : 'put',
          bid,
          ask,
          last,
          mid: (bid + ask) / 2,
          volume: parseInt(snap['71']?.v) || 0,
          openInterest: 0,
          conid: contract.conid,
        })
      }
    } catch { }
  }

  chain.sort((a, b) => a.strike - b.strike)

  let spotPrice = 0
  try {
    const spotData = await api('/iserver/marketdata/snapshot', {
      method: 'POST',
      body: JSON.stringify({ conids: [416904], fields: ['31'] }),
    })
    if (spotData && spotData.length > 0) {
      spotPrice = parseFloat(spotData[0]['31']?.v) || 0
    }
  } catch { }

  return { date: todayStr, spotPrice, chainSize: chain.length, chain }
}

export async function getSpotPrice() {
  try {
    const data = await api('/iserver/marketdata/snapshot', {
      method: 'POST',
      body: JSON.stringify({ conids: [SPX_CONID], fields: ['31'] }),
    })
    if (data && data.length > 0) return parseFloat(data[0]['31']?.v) || 0
  } catch { }
  return 0
}

export async function getAccounts() {
  try {
    return await api('/iserver/accounts')
  } catch {
    return { accounts: [] }
  }
}

export async function placeOrder(accountId, contract, action, quantity, orderType, price) {
  const order = {
    acctId: accountId,
    conid: contract.conid || contract.strike,
    orderType: orderType || 'MKT',
    price: price ?? 0,
    quantity,
    side: action,
    tif: 'DAY',
    outsideRTH: false,
  }

  return api(`/iserver/account/${accountId}/orders`, {
    method: 'POST',
    body: JSON.stringify({ orders: [order] }),
  })
}

export async function startLiveFeed(onChain, onSpot, onError) {
  const poll = async () => {
    while (true) {
      try {
        const status = await isAvailable()
        if (!status.connected || !status.authenticated) {
          onError?.('IB Gateway not connected or not authenticated')
          await new Promise(r => setTimeout(r, 5000))
          continue
        }

        const chainData = await getOptionChain()
        if (chainData.chain.length > 0) onChain?.(chainData)

        const spot = await getSpotPrice()
        if (spot > 0) onSpot?.(spot)

        await new Promise(r => setTimeout(r, POLL_INTERVAL))
      } catch (err) {
        onError?.(err.message)
        await new Promise(r => setTimeout(r, POLL_INTERVAL))
      }
    }
  }

  poll()
}
