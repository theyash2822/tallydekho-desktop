/**
 * Is TallyPrime running? "running" | "closed" | "unknown". A failed query is "unknown", and
 * unknown is never treated as closed (R5 / 18, D-005): backups do not copy company files and
 * setup does not start a second Tally on a guess.
 */
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

async function tallyProcessState({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform !== "win32") return { state: "closed" };
  try {
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$p = Get-Process -Name tally -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { 'RUNNING|' + $p.Path } else { 'CLOSED|' }",
    ], { timeout: 15_000, windowsHide: true });
    const line = String(stdout || "").trim().split(/\r?\n/).pop() || "";
    if (line.startsWith("RUNNING|")) return { state: "running", path: line.slice(8) || null };
    if (line === "CLOSED|") return { state: "closed" };
    return { state: "unknown", reason: "unexpected_output" };
  } catch (err) {
    return { state: "unknown", reason: err?.code || "query_failed" };
  }
}

module.exports = { tallyProcessState };
