import React, { useContext, useMemo, useState } from "react";
import { formatDateTime } from "../../utils/datetime";
import AddCompaniesModal from "./modals/AddCompaniesModal";
import EditYearsModal from "./modals/EditYearsModal";
import { TallyContext } from "../../utils/TallyContext";
import YearChip from "../components/YearChip";
import AlertModal from "../components/AlertModal";

function StatusChip({ s }) {
  const map = {
    connected: { t: "Connected", tone: "success" },
    disconnected: { t: "Disconnected", tone: "danger" },
    paused: { t: "Paused", tone: "warn" },
    error: { t: "Error", tone: "danger" },
  };
  const m = map[s] || { t: s, tone: "default" };
  return (
    <span
      className={`text-xs rounded-full border px-2 py-0.5 ${
        m.tone === "success"
          ? "bg-emerald-50 text-emerald-800"
          : m.tone === "danger"
          ? "bg-rose-50 text-rose-800"
          : m.tone === "warn"
          ? "bg-amber-50 text-amber-800"
          : "bg-slate-50 text-slate-700"
      }`}
      style={{ borderColor: "#D5D9E4" }}
    >
      {m.t}
    </span>
  );
}

export default function Companies({
  onManualSync,
  onHardSync,
  disableSyncButton,
}) {
  const [checkedCompanies, setCheckedCompanies] = useState({});
  const [isAddCompanyModalOpen, setIsAddCompanyModalOpen] = useState(false);

  const [editYearModalData, setEditYearModalData] = useState({
    isModalOpen: false,
    years: [],
    companyId: null,
    checkedYears: {},
  });

  const [alertModalData, setAlertModalData] = useState({
    isOpen: false,
    message: null,
  });

  const {
    state: { companies, selectedCompanies, isSyncing, isTallyOnline, isOnline },
    updateState,
  } = useContext(TallyContext);

  function toggle(id, v) {
    setCheckedCompanies((s) => ({ ...s, [id]: v ?? !s[id] }));
  }

  const updateAllSelection = () => {
    if (isAllChecked) {
      const newSel = { ...checkedCompanies };
      for (let key in newSel) {
        newSel[key] = false;
      }
      setCheckedCompanies(newSel);
    } else {
      setCheckedCompanies(
        selectedCompanies.reduce((acc, cv) => {
          acc[cv.id] = true;
          return acc;
        }, {})
      );
    }
  };

  const openAddCompaniesModal = () => {
    if (!isTallyOnline) {
      setAlertModalData({
        isOpen: true,
        message: "Tally is currently disconnected.",
      });
      return;
    }
    if (selectedCompanies.length == companies.length || companies.length == 0) {
      setAlertModalData({
        isOpen: true,
        message: "There are no companies available to add.",
      });
      return;
    }
    setIsAddCompanyModalOpen(true);
  };

  const syncingHelper = () => {
    if (!isSyncing) {
      if (!isTallyOnline) {
        setAlertModalData({
          isOpen: true,
          message: "Tally is currently disconnected.",
        });
        return false;
      } else if (!isOnline) {
        setAlertModalData({
          isOpen: true,
          message: "The internet connection is currently disconnected.",
        });
        return false;
      }
    }

    if (selectedCompanies.length == 0) {
      setAlertModalData({
        isOpen: true,
        message: "There are no companies available to synchronize",
      });
      return false;
    }

    return true;
  };

  const startSyncingHandler = () => {
    const allowed = syncingHelper();
    if (!allowed) {
      return;
    }
    onManualSync(selectedCompanies);
  };

  const startHardSyncHandler = () => {
    const allowed = syncingHelper();
    if (!allowed) {
      return;
    }
    onHardSync();
  };

  const updateSelectedCompanies = (selected) => {
    updateState("selectedCompanies", (prev) => [...prev, ...selected]);
    setIsAddCompanyModalOpen(false);
  };

  const openEditYearsModal = (years, allYears, companyId) => {
    const checkedYears = allYears.reduce((acc, cv) => {
      acc[cv.finYear] = false;
      return acc;
    }, {});

    years.forEach((year) => {
      checkedYears[year.finYear] = true;
    });

    setEditYearModalData({
      isModalOpen: true,
      years: allYears,
      companyId,
      checkedYears,
    });
  };

  const closeEditYearsModal = () => {
    setEditYearModalData({
      isModalOpen: false,
      years: [],
      companyId: null,
      checkedYears: {},
    });
  };

  const updateYearsHandler = (years) => {
    const newSelectedCompanies = [...selectedCompanies];
    const idx = newSelectedCompanies.findIndex(
      (company) => company.id == editYearModalData.companyId
    );

    if (idx == -1) {
      return;
    }

    newSelectedCompanies[idx].years = years;
    updateState("selectedCompanies", newSelectedCompanies);

    closeEditYearsModal();
  };

  const removeCompanyHandler = (index) => {
    updateState("selectedCompanies", (prev) =>
      prev.filter((_, idx) => index != idx)
    );
  };

  const removeMultiHandler = () => {
    updateState("selectedCompanies", (prev) =>
      prev.filter((item) => !checkedCompanies[item.id])
    );

    const newCheckedCompanies = {};

    for (let key in checkedCompanies) {
      if (!checkedCompanies[key]) {
        newCheckedCompanies[key] = false;
      }
    }
    setCheckedCompanies(newCheckedCompanies);
  };

  const closeAlertSyncModal = () => {
    setAlertModalData({ isOpen: false, message: null });
  };

  const isAllChecked = useMemo(() => {
    const companiesLength = selectedCompanies.length;
    const selectionCount = Object.values(checkedCompanies).filter(
      (value) => value
    ).length;

    return companiesLength == 0 ? false : companiesLength == selectionCount;
  }, [selectedCompanies, checkedCompanies]);

  const anyChecked = Object.values(checkedCompanies).some(Boolean);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">My Companies</div>
        <div className="flex items-center gap-2">
          <button
            onClick={openAddCompaniesModal}
            className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
            style={{ borderColor: "#D5D9E4" }}
          >
            Add Companies
          </button>
          <button
            onClick={startSyncingHandler}
            className={`px-3 py-1.5 rounded-md border ${
              disableSyncButton
                ? "bg-[#F3F4F6] text-[#9CA3AF] cursor-not-allowed"
                : "text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
            }`}
            style={{ borderColor: "#D5D9E4" }}
            disabled={disableSyncButton}
          >
            {isSyncing ? "Stop Syncing" : "Sync Now"}
          </button>
          <button
            onClick={startHardSyncHandler}
            className={`px-3 py-1.5 rounded-md border ${
              disableSyncButton || isSyncing
                ? "bg-[#F3F4F6] text-[#9CA3AF] cursor-not-allowed border-[#D5D9E4]"
                : "text-slate-700 hover:bg-rose-50 hover:text-rose-700 border-[#fca5a5]"
            }`}
            disabled={disableSyncButton || isSyncing}
          >
            Hard Sync
          </button>
        </div>
      </div>
      {anyChecked && (
        <div className="flex items-center gap-2 text-sm">
          {/* <button
            className="px-2 py-1 rounded-md border"
            style={{ borderColor: "#D5D9E4" }}
          >
            Enable Sync
          </button>
          <button
            className="px-2 py-1 rounded-md border"
            style={{ borderColor: "#D5D9E4" }}
          >
            Disable Sync
          </button> */}
          <button
            className="px-2 py-1 rounded-md border text-slate-700 hover:bg-slate-50 hover:text-slate-800"
            style={{ borderColor: "#D5D9E4" }}
            onClick={removeMultiHandler}
          >
            Remove
          </button>
        </div>
      )}
      <div
        className="rounded-lg border overflow-hidden p-2"
        style={{ borderColor: "#D5D9E4" }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 bg-slate-50">
              {false && (
                <th className="py-2 px-2 w-8">
                  {selectedCompanies.length > 0 && (
                    <input
                      type="checkbox"
                      checked={isAllChecked}
                      onChange={updateAllSelection}
                      className="block mx-auto"
                    />
                  )}
                </th>
              )}
              <th className="py-2 px-2">Company</th>
              {/* <th className="py-2 px-2">Last Synced</th> */}
              {/* <th className="py-2 px-2">Status</th> */}
              <th className="py-2 px-2">Ledgers</th>
              <th className="py-2 px-2">Years</th>
              <th className="py-2 px-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {selectedCompanies.map((company, index) => {
              // const mod = (index + 1) % 3;

              // const toneRow =
              //   mod == 1
              //     ? "hover:bg-emerald-50"
              //     : mod == 2
              //     ? "hover:bg-amber-50"
              //     : "hover:bg-rose-50";
              const toneRow = "hover:bg-emerald-50";

              let YearComponent = <></>;

              if (company.years.length <= 2) {
                YearComponent = company.years.map((year, idx) => (
                  <StatusChip key={idx} s={year.finYear} />
                ));
              } else {
                YearComponent = (
                  <>
                    <StatusChip s={company.years[0].finYear} />
                  </>
                );
              }

              return (
                <tr
                  key={company.id}
                  className={`border-t transition-colors ${toneRow} ${
                    (index + 1) % 2 == 0 ? "bg-slate-50" : ""
                  }`}
                  style={{ borderColor: "#D5D9E4" }}
                >
                  {false && (
                    <td className="py-2 px-2">
                      <input
                        type="checkbox"
                        checked={!!checkedCompanies[company.id]}
                        onChange={(e) => toggle(company.id, e.target.checked)}
                        className="block mx-auto"
                      />
                    </td>
                  )}
                  <td className="py-2 px-2">
                    <div className="font-medium max-w-[100px] truncate">
                      {company.name}
                    </div>
                    {/* <div className="text-xs text-slate-500">{company.guid}</div> */}
                  </td>
                  {/* <td className="py-2 px-2">
                    <span className="text-[12px]">
                      {company.last ? formatDateTime(company.last) : "—"}
                    </span>
                  </td> */}
                  {/* <td className="py-2 px-2">
                    <StatusChip s={company.status} />
                  </td> */}
                  <td className="py-2 px-2">{company.ledgersCount ?? "—"}</td>
                  <td>
                    <div className="py-2 px-2 gap-1 flex flex-wrap w-[170px] overflow-visible">
                      {YearComponent}
                      {company.years.length > 2 && (
                        <YearChip years={company.years} />
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex gap-2">
                      <button
                        className="px-2 py-1 rounded-md border text-slate-700 hover:bg-slate-50 hover:text-slate-800 w-[80px]"
                        style={{ borderColor: "#D5D9E4" }}
                        onClick={() => {
                          openEditYearsModal(
                            company.years,
                            company.allYears,
                            company.id
                          );
                        }}
                      >
                        Edit Years
                      </button>
                      <button
                        className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-slate-50 hover:text-slate-800"
                        style={{ borderColor: "#D5D9E4" }}
                        onClick={() => removeCompanyHandler(index)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {isAddCompanyModalOpen && (
        <AddCompaniesModal
          onClose={() => setIsAddCompanyModalOpen(false)}
          onAdd={updateSelectedCompanies}
        />
      )}
      {editYearModalData.isModalOpen && (
        <EditYearsModal
          onClose={closeEditYearsModal}
          years={editYearModalData.years}
          defaultCheckedYears={editYearModalData.checkedYears}
          onAdd={updateYearsHandler}
        />
      )}
      {alertModalData.isOpen && (
        <AlertModal
          message={alertModalData.message}
          onClose={closeAlertSyncModal}
        />
      )}
    </div>
  );
}
