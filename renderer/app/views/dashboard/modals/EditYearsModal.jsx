import React, { Fragment, useContext, useEffect, useState } from "react";

const border = { borderColor: "#D5D9E4" };

export default function EditYearsModal({
  onClose,
  onAdd,
  years,
  defaultCheckedYears,
}) {
  const [checkedYears, setCheckedYears] = useState(defaultCheckedYears);

  const anyChecked = Object.values(checkedYears).some(Boolean);

  const onSubmit = () => {
    const selectedYears = years.filter((year) => checkedYears[year.finYear]);

    if (selectedYears.length == 0) {
      return;
    }

    onAdd(selectedYears);
  };

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center !m-0">
      <div className="bg-white rounded-xl border w-[560px]" style={border}>
        <div
          className="flex items-center justify-between px-4 py-2 border-b"
          style={border}
        >
          <div className="font-semibold">Edit Years</div>
          <button onClick={onClose} className="text-slate-500">
            ✕
          </button>
        </div>
        <div className="p-4 space-y-2 text-sm">
          <div className="flex flex-wrap gap-2 rounded-md px-3 py-2">
            {years.map((year) => (
              <div
                className="text-xs rounded-md border px-2 py-1.5 flex items-center gap-1 "
                style={{ borderColor: "#D5D9E4" }}
                key={year.finYear}
                onClick={() => {
                  setCheckedYears((prev) => ({
                    ...prev,
                    [year.finYear]: !prev[year.finYear],
                  }));
                }}
              >
                <input
                  type="checkbox"
                  checked={checkedYears[year.finYear]}
                  readOnly
                  // onChange={(e) => {
                  //   setCheckedYears((prev) => ({
                  //     ...prev,
                  //     [year.finYear]: e.target.checked,
                  //   }));
                  // }}
                />
                <span>{year.finYear}</span>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              className="px-3 py-1.5 rounded-md border"
              style={border}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
              style={border}
              disabled={!anyChecked}
              onClick={onSubmit}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
