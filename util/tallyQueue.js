/**
 * Tally answers each HTTP request in the context of one "current company".
 * Overlapping requests for different companies (parallel master fetches, the
 * 5-second company poll, write-backs) can be answered from the wrong company,
 * so every request to Tally goes through this single-file queue.
 * Never call runTallyExclusive from inside another queued task: it would deadlock.
 */
let tail = Promise.resolve();

function runTallyExclusive(task) {
  const run = tail.then(task, task);
  tail = run.catch(() => {});
  return run;
}

/**
 * One company's multi-request unit (bill snapshot: Context → Bills) runs as a
 * whole before the next company's unit starts, even when sync and Settings ask
 * at the same time. Separate chain from runTallyExclusive, so the unit's own
 * requests (which still go through runTallyExclusive) cannot deadlock it.
 * Never nest runCompanyExclusive.
 */
let companyTail = Promise.resolve();

function runCompanyExclusive(task) {
  const run = companyTail.then(task, task);
  companyTail = run.catch(() => {});
  return run;
}

/** Escape a value placed in XML element text (e.g. SVCURRENTCOMPANY "Shah & Sons"). */
function xmlText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = { runTallyExclusive, runCompanyExclusive, xmlText };
