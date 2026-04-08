import React, {
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TallyContext } from "../../../utils/TallyContext";

const border = { borderColor: "#E9E8E3" };

export default function AddCompaniesModal({ onClose, onAdd }) {
  const {
    state: { companies, selectedCompanies },
  } = useContext(TallyContext);

  const [checkedCompanies, setCheckedCompanies] = useState(
    companies.reduce((acc, company) => {
      acc[company.id] = false;
      return acc;
    }, {})
  );

  const [checkedCompanyYears, setCheckedCompanyYears] = useState(
    companies.reduce((acc, company) => {
      acc[company.id] = company.allYears.reduce((acc, cv) => {
        acc[cv.finYear] = false;
        return acc;
      }, {});
      return acc;
    }, {})
  );

  useEffect(() => {
    setCheckedCompanies(
      companies.reduce((acc, company) => {
        acc[company.id] = false;
        return acc;
      }, {})
    );

    setCheckedCompanyYears(
      companies.reduce((acc, company) => {
        acc[company.id] = company.allYears.reduce((acc, cv) => {
          acc[cv.finYear] = false;
          return acc;
        }, {});
        return acc;
      }, {})
    );
  }, [companies.length]);

  const onSubmit = () => {
    const selectedCompanies = [];

    companies.forEach((company) => {
      if (checkedCompanies[company.id]) {
        selectedCompanies.push(company);
      } else {
        const finYears = checkedCompanyYears[company.id];

        const years = company.allYears.filter((year) => finYears[year.finYear]);

        if (years.length > 0) {
          selectedCompanies.push({
            ...company,
            years,
          });
        }
      }
    });

    onAdd(selectedCompanies);
  };

  const yearUpdateHandler = ({ value, company, year }) => {
    setCheckedCompanyYears((prev) => ({
      ...prev,
      [company.id]: company.allYears.reduce((acc, cv, index) => {
        const isChecked =
          year.finYear == cv.finYear
            ? value
            : checkedCompanyYears[company.id][cv.finYear];

        acc[cv.finYear] = isChecked;

        if (company.allYears.length - 1 == index) {
          if (!value) {
            setCheckedCompanies((s) => ({
              ...s,
              [company.id]: false,
            }));
          } else {
            const alreadyChecked = Object.values(
              checkedCompanyYears[company.id]
            ).filter((item) => item);

            if (alreadyChecked.length == company.allYears.length - 1) {
              setCheckedCompanies((s) => ({
                ...s,
                [company.id]: true,
              }));
            }
          }
        }

        return acc;
      }, {}),
    }));
  };

  const nonSelectedCompanies = useMemo(() => {
    const selectedCompanyIds = selectedCompanies.map((company) => company.id);
    return companies.filter(
      (company) => !selectedCompanyIds.includes(company.id)
    );
  }, [selectedCompanies, companies]);

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center !m-0">
      <div
        className="bg-white rounded-xl border w-[560px] h-[80vh] overflow-auto"
        style={border}
      >
        <div
          className="flex items-center justify-between px-4 py-2 border-b"
          style={border}
        >
          <div className="font-semibold">
            Add Companies (Discovered via Tally)
          </div>
          <button onClick={onClose} className="text-[#9A9A97]">
            ✕
          </button>
        </div>
        <div className="p-4 space-y-2 text-sm">
          {nonSelectedCompanies.map((company) => (
            <div className="border rounded-md px-3 py-2" key={company.id}>
              <label
                className="flex items-center justify-between"
                style={border}
              >
                <div>
                  <div className="font-medium">{company.name}</div>
                  <div className="text-xs text-[#9A9A97]">
                    GUID {company.guid}
                    {/* · Path {company.path} */}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={checkedCompanies[company.id]}
                  onChange={(e) => {
                    setCheckedCompanies((s) => ({
                      ...s,
                      [company.id]: e.target.checked,
                    }));
                    setCheckedCompanyYears((s) => ({
                      ...s,
                      [company.id]: company.allYears.reduce((acc, cv) => {
                        acc[cv.finYear] = e.target.checked;
                        return acc;
                      }, {}),
                    }));
                  }}
                />
              </label>
              <div className="flex flex-wrap gap-2 mt-3">
                {company.years?.map((year, idx) => (
                  <div
                    className="text-xs rounded-md border px-2 py-1.5 flex items-center gap-1 "
                    style={{ borderColor: "#E9E8E3" }}
                    key={year.finYear}
                    onClick={() =>
                      yearUpdateHandler({
                        value:
                          !checkedCompanyYears?.[company.id]?.[year.finYear],
                        company,
                        year,
                      })
                    }
                  >
                    <input
                      type="checkbox"
                      checked={
                        checkedCompanyYears?.[company.id]?.[year.finYear]
                      }
                      readOnly
                      // onChange={(e) => {
                      //   setCheckedCompanyYears((prev) => ({
                      //     ...prev,
                      //     [company.id]: company.allYears.reduce(
                      //       (acc, cv, index) => {
                      //         const isChecked =
                      //           year.finYear == cv.finYear
                      //             ? e.target.checked
                      //             : checkedCompanyYears[company.id][cv.finYear];

                      //         acc[cv.finYear] = isChecked;

                      //         if (company.allYears.length - 1 == index) {
                      //           if (!e.target.checked) {
                      //             setCheckedCompanies((s) => ({
                      //               ...s,
                      //               [company.id]: false,
                      //             }));
                      //           } else {
                      //             const alreadyChecked = Object.values(
                      //               checkedCompanyYears[company.id]
                      //             ).filter((item) => item);

                      //             if (
                      //               alreadyChecked.length ==
                      //               company.allYears.length - 1
                      //             ) {
                      //               setCheckedCompanies((s) => ({
                      //                 ...s,
                      //                 [company.id]: true,
                      //               }));
                      //             }
                      //           }
                      //         }

                      //         return acc;
                      //       },
                      //       {}
                      //     ),
                      //   }));
                      // }}
                    />
                    <span>{year.finYear}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-2">
            <button
              className="px-3 py-1.5 rounded-md border"
              style={border}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#E8F5ED] hover:text-[#2D7D46]"
              style={border}
              onClick={onSubmit}
            >
              Add Selected
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
