import type { SessionInfo, SessionData, ChainResponse } from './types'

const BASE = '/api'

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.statusText}`)
  return res.json()
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  const data = await fetchJson<{ sessions: SessionInfo[] }>(`${BASE}/sessions`)
  return data.sessions
}

export async function fetchSession(date: string): Promise<SessionData> {
  return fetchJson<SessionData>(`${BASE}/sessions/${date}`)
}

export async function fetchChain(date: string): Promise<ChainResponse> {
  return fetchJson<ChainResponse>(`${BASE}/chain/${date}`)
}

export async function checkHealth(): Promise<{ status: string; datesAvailable: number }> {
  return fetchJson(`${BASE}/health`)
}
