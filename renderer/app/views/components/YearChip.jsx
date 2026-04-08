import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function YearChip({ years }) {
  const chipRef = useRef(null);
  const [open, setOpen] = useState(false);

  const [pos, setPos] = useState({ top: 0, left: 0 });

  const updatePosition = () => {
    const r = chipRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      top: r.top + r.height / 2, // center vertically
      left: r.right + 8, // 8px gap to the right
    });
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onScrollOrResize = () => updatePosition();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  return (
    <>
      {/* Put this inside your <td className="..."> */}
      <div
        ref={chipRef}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="relative inline-block group border bg-[#F5F4EF] rounded-full text-xs px-2 py-0.5 cursor-pointer text-[#787774]"
        style={{ borderColor: "#E9E8E3" }}
      >
        +{years.length - 1}
      </div>

      {open &&
        createPortal(
          <div
            // fixed = escapes any overflow/stacking of the table wrapper
            className="fixed z-50 text-xs text-[#787774]"
            style={{
              top: pos.top,
              left: pos.left,
              transform: "translateY(-50%)",
            }}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          >
            <div className="relative rounded-md bg-white border border-[#E9E8E3] shadow-md p-2">
              {/* arrow */}
              <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-2 rotate-45 bg-white border-l border-t border-[#E9E8E3]" />
              {/* grid: 2 per row, equal gaps */}
              <ul className="grid grid-cols-2 gap-1">
                {years.slice(1).map((y, i) => (
                  <li
                    key={i}
                    className="text-xs rounded-full border px-2 py-0.5 bg-[#F5F4EF] text-[#787774] whitespace-nowrap"
                    style={{ borderColor: "#E9E8E3" }}
                  >
                    {y.finYear}
                  </li>
                ))}
              </ul>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

export default YearChip;
