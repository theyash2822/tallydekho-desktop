function parseYyyyMmDd(s) {
  const y = +s.slice(0, 4),
    m = +s.slice(4, 6) - 1,
    d = +s.slice(6, 8);
  return new Date(Date.UTC(y, m, d));
}

function fmtYyyyMmDd(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function addYearsUTC(dt, years) {
  return new Date(
    Date.UTC(dt.getUTCFullYear() + years, dt.getUTCMonth(), dt.getUTCDate())
  );
}

function addDaysUTC(dt, days) {
  return new Date(
    Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() + days)
  );
}

function createFinancialYears(startingFrom, endingAt) {
  let begin = parseYyyyMmDd(startingFrom);
  const endCap = parseYyyyMmDd(endingAt);
  if (begin > endCap) return [];

  const spans = [];
  while (begin <= endCap) {
    let nominalEnd = addDaysUTC(addYearsUTC(begin, 1), -1);
    const end = nominalEnd > endCap ? endCap : nominalEnd;

    const fyLabel = `${begin.getUTCFullYear()}-${begin.getUTCFullYear() + 1}`;
    const beginStr = fmtYyyyMmDd(begin);
    const endStr = fmtYyyyMmDd(nominalEnd);

    spans.push({ finYear: fyLabel, begin: beginStr, end: endStr });

    begin = addDaysUTC(end, 1);
  }
  return spans;
}

module.exports = createFinancialYears;

// createFinancialYears("20170401", "20231120");
