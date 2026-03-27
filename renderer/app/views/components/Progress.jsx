import React from 'react'

export default function Progress({ value }) {
  return (
    <div
      className="w-full h-2 rounded-full bg-slate-200"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-2 rounded-full" style={{ width: `${value}%`, background: '#39947E' }} />
    </div>
  )
}