import type { SessionData } from '../types'
import { XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts'

interface Props {
  data: SessionData | null
  loading: boolean
}

export default function Overview({ data, loading }: Props) {
  if (loading) {
    return <div className="text-center py-12 text-ztextdim animate-pulse">Loading session data...</div>
  }

  if (!data) {
    return (
      <div className="text-center py-12 text-ztextdim">
        <p>No session data available.</p>
        <p className="text-xs mt-2">Select a date from the dropdown.</p>
      </div>
    )
  }

  const currPrice = data.pricePath[data.pricePath.length - 1]?.price || data.spotPrice
  const change = currPrice - data.spotPrice
  const changePct = (change / data.spotPrice) * 100

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Spot" value={`$${data.spotPrice.toFixed(2)}`} />
        <StatCard label="Current" value={`$${currPrice.toFixed(2)}`} change={change.toFixed(2)} changePct={changePct.toFixed(2)} />
        <StatCard label="Day High" value={`$${data.dailyHigh.toFixed(2)}`} />
        <StatCard label="Day Low" value={`$${data.dailyLow.toFixed(2)}`} />
      </div>

      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Intraday Price</h3>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={data.pricePath}>
            <defs>
              <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#6b7280' }} interval={5} />
            <YAxis domain={['dataMin - 5', 'dataMax + 5']} tick={{ fontSize: 11, fill: '#6b7280' }} />
            <Tooltip
              contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 8, fontSize: 13 }}
              labelStyle={{ color: '#c4c4d4' }}
            />
            <Area type="monotone" dataKey="price" stroke="#06b6d4" fill="url(#priceGrad)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
        <h3 className="text-sm font-medium text-ztextdim mb-3">Session Info</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <InfoItem label="Date" value={data.date} />
          <InfoItem label="Chain Size" value={`${data.chainSize} strikes`} />
          <InfoItem label="0DTE" value={data.hasZeroDte ? 'Yes' : 'No'} />
          <InfoItem label="Range" value={`$${data.dailyLow.toFixed(0)} - $${data.dailyHigh.toFixed(0)}`} />
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, change, changePct }: { label: string; value: string; change?: string; changePct?: string }) {
  const isPositive = change && parseFloat(change) >= 0
  return (
    <div className="bg-zgray/30 border border-zborder rounded-lg p-4">
      <div className="text-xs text-ztextdim mb-1">{label}</div>
      <div className="text-xl font-semibold text-white font-mono">{value}</div>
      {change !== undefined && (
        <div className={`text-xs mt-1 font-mono ${isPositive ? 'text-zgreen' : 'text-zred'}`}>
          {isPositive ? '+' : ''}{change} ({isPositive ? '+' : ''}{changePct}%)
        </div>
      )}
    </div>
  )
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-ztextdim">{label}: </span>
      <span className="text-white">{value}</span>
    </div>
  )
}
