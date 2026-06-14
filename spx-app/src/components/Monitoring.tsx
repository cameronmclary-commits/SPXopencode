import { useState, useEffect } from 'react'
import { checkHealth } from '../api'

export default function Monitoring() {
  const [health, setHealth] = useState<{ status: string; datesAvailable: number } | null>(null)
  const [lastCheck, setLastCheck] = useState<Date | null>(null)

  useEffect(() => {
    const check = () => {
      checkHealth()
        .then(h => { setHealth(h); setLastCheck(new Date()) })
        .catch(() => setHealth(null))
    }
    check()
    const id = setInterval(check, 15000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="space-y-6">
      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">API Status</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${health ? 'bg-zgreen' : 'bg-zred'}`} />
            <span>{health ? 'Connected' : 'Disconnected'}</span>
          </div>
          {health && (
            <>
              <InfoRow label="Status" value={health.status} />
              <InfoRow label="Available Sessions" value={String(health.datesAvailable)} />
            </>
          )}
          {lastCheck && <InfoRow label="Last Check" value={lastCheck.toLocaleTimeString()} />}
        </div>
      </div>

      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Dashboard Info</h3>
        <div className="space-y-2 text-sm">
          <InfoRow label="Version" value="1.0.0" />
          <InfoRow label="Backend" value="options-api (Express)" />
          <InfoRow label="Data Source" value="gar-c/OptionData (Parquet)" />
          <InfoRow label="Frontend" value="React + Vite + Tailwind" />
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-ztextdim">{label}</span>
      <span className="text-white font-mono text-xs">{value}</span>
    </div>
  )
}
