import React from 'react'

const border = { borderColor: '#D5D9E4' }

export default function Badge({ label, tone = 'default' }) {
  const bg =
    tone === 'success'
      ? 'bg-emerald-50 text-emerald-800'
      : tone === 'danger'
      ? 'bg-rose-50 text-rose-800'
      : tone === 'warn'
      ? 'bg-amber-50 text-amber-800'
      : 'bg-slate-50 text-slate-700'
  return (
    <span className={`text-xs rounded-full border px-2 py-0.5 ${bg}`} style={border}>
      {label}
    </span>
  )
}