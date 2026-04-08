import React from 'react';

export default function Badge({ label, tone = 'default' }) {
  const styles = {
    success: { background: '#E8F5ED', color: '#2D7D46', border: '1px solid #A8D5BC' },
    danger:  { background: '#FDECEA', color: '#C0392B', border: '1px solid #EDBBB8' },
    warn:    { background: '#FFFBEB', color: '#D97706', border: '1px solid #FDE68A' },
    default: { background: '#F5F4EF', color: '#787774', border: '1px solid #E9E8E3' },
  };
  const s = styles[tone] || styles.default;
  return (
    <span
      className="text-xs rounded-full px-2 py-0.5"
      style={s}
    >
      {label}
    </span>
  );
}
