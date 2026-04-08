import React from 'react'

export default function Progress({ value }) {
  return (
    <div
      className="w-full h-2 rounded-full bg-[#E8E7E1]"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-2 rounded-full" style={{ width: `${value}%`, background: '#2D7D46' }} />
    </div>
  )
}