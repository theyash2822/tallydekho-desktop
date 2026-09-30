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

/** Escape a value placed in XML element text (e.g. SVCURRENTCOMPANY "Shah & Sons"). */
function xmlText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = { runTallyExclusive, xmlText };
