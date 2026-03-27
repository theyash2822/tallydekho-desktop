const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function findOnPath(cmd) {
  try {
    const out = execFileSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", `where ${cmd}`],
      { windowsHide: true, encoding: "utf8" }
    );
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return first && exists(first) ? first : null;
  } catch {
    return null;
  }
}

function resolvePowerShell() {
  // 1) Prefer PowerShell 7 (pwsh)
  const pwshFromPath = findOnPath("pwsh.exe") || findOnPath("pwsh");
  if (pwshFromPath) return { exe: pwshFromPath, kind: "pwsh7" };

  // 2) Fall back to Windows PowerShell 5.1 (powershell.exe)
  const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const isWow64 =
    process.arch === "ia32" && !!process.env.PROCESSOR_ARCHITEW6432;

  // When a 32-bit process needs the 64-bit System32, use Sysnative
  const ps51Sysnative = path.join(
    sysRoot,
    "Sysnative",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const ps51System32 = path.join(
    sysRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );

  if (isWow64 && exists(ps51Sysnative))
    return { exe: ps51Sysnative, kind: "powershell51" };
  if (exists(ps51System32)) return { exe: ps51System32, kind: "powershell51" };

  // 3) Last try: on PATH
  const psFromPath = findOnPath("powershell.exe") || findOnPath("powershell");
  if (psFromPath) return { exe: psFromPath, kind: "powershell51" };

  throw new Error("PowerShell not found (neither pwsh nor powershell.exe).");
}

module.exports = resolvePowerShell;
