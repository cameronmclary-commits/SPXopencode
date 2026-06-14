export function ParamInput({
  label, value, onChange, min, max, step,
}: {
  label: string; value: number; onChange: (v: number) => void
  min: number; max: number; step?: number
}) {
  return (
    <div>
      <label className="text-[10px] text-ztextdim tracking-wide uppercase">{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        onFocus={e => e.target.select()}
        min={min} max={max} step={step || 1}
        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-20 transition-all duration-200"
      />
    </div>
  )
}

export function TimeInput({
  label, value, onChange,
}: {
  label: string; value: string; onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="text-[10px] text-ztextdim tracking-wide uppercase">{label}</label>
      <input
        type="time"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-zgray border border-zborder rounded px-2 py-1 text-xs text-ztext w-full transition-all duration-200"
      />
    </div>
  )
}

export function Row({
  label, value, color,
}: {
  label: string; value: string; color?: string
}) {
  return (
    <div className="flex justify-between py-1 border-b border-zborder/30 last:border-0">
      <span className="text-ztextdim">{label}</span>
      <span className={`font-mono ${color || 'text-white'}`}>{value}</span>
    </div>
  )
}

export function MetricCard({
  label, value, color,
}: {
  label: string; value: string | number; color?: string
}) {
  return (
    <div className="panel-bg border border-zborder rounded-lg p-3">
      <div className="text-[10px] text-ztextdim tracking-wide uppercase mb-0.5">{label}</div>
      <div className={`text-sm font-semibold font-mono ${color || 'text-white'}`}>{value}</div>
    </div>
  )
}
