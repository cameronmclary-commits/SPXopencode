export interface SessionInfo {
  id: string
  date: string
}

export interface PricePoint {
  time: string
  price: number
}

export interface OptionRow {
  strike: number
  type: 'call' | 'put'
  bid: number
  ask: number
  last: number
  mid: number
  volume: number
  openInterest: number
  conid?: number
  delta?: number
  gamma?: number
  theta?: number
  vega?: number
  iv?: number
}

export interface SessionData {
  id: string
  date: string
  spotPrice: number
  pricePath: PricePoint[]
  openingChain: OptionRow[]
  chainSize: number
  hasZeroDte: boolean
  dailyLow: number
  dailyHigh: number
  dailyClose: number
  dailyChange: number
}

export interface ChainResponse {
  date: string
  spotPrice: number
  chainSize: number
  chain: OptionRow[]
}

export interface PaperTrade {
  id: string
  sessionId: string
  timestamp: string
  strike: number
  type: 'call' | 'put'
  action: 'buy' | 'sell'
  entryPrice: number
  exitPrice?: number
  quantity: number
  pnl?: number
  status: 'open' | 'closed'
  entryTick?: number
  exitTick?: number
}
