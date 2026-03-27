import { useState, useRef, useEffect } from "react";

export default function CustomSelect({
  value,
  onChange,
  options,
  label,
  disabled = false,
  buttonClasses = "",
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleToggle = () => {
    if (!disabled) setOpen((o) => !o);
  };

  const selectedLabel =
    options.find((opt) => opt.value === value)?.label || "Select";

  return (
    <div className="inline-flex items-center gap-2 text-sm text-gray-800">
      <span className="text-sm">{label}</span>
      <div className="relative" ref={ref}>
        <button
          type="button"
          disabled={disabled}
          onClick={handleToggle}
          className={`h-9 px-3 pr-8 rounded-md text-left flex items-center justify-between border outline-none appearance-none relative ${buttonClasses}
            ${
              disabled
                ? "bg-[#F3F4F6] border-[#D1D5DB] text-[#9CA3AF] cursor-not-allowed"
                : "bg-white border-[#D5D9E4] text-gray-800 hover:border-[#BFC6D4]"
            }`}
        >
          <span>{selectedLabel}</span>
          <svg
            className={`absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 ${
              disabled ? "text-[#C5CAD3]" : "text-gray-600"
            } transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path d="M5.5 7.5l4.5 4.5 4.5-4.5" />
          </svg>
        </button>

        {open && (
          <ul className="absolute top-full left-0 w-full bg-white border border-[#D5D9E4] rounded-md shadow-sm z-10">
            {options.map((opt) => (
              <li
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`px-3 py-[6px] cursor-pointer select-none ${
                  value === opt.value
                    ? "bg-emerald-50 text-emerald-700"
                    : "hover:bg-emerald-50 hover:text-emerald-700"
                }`}
              >
                {opt.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
