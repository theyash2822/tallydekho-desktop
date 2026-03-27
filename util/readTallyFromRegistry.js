const { execFile } = require("child_process");

function runPS(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve((stdout || "").trim()))
    );
  });
}

async function getFromRegistry() {
  const ps = `
$paths = @(
  "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
)
$items = foreach ($p in $paths) {
  if (Test-Path $p) { Get-ChildItem $p | ForEach-Object { Get-ItemProperty $_.PsPath } }
}
$matches = $items | Where-Object { $_.DisplayName -match 'Tally' }
$matches | Select-Object DisplayName, DisplayVersion, InstallLocation, PSChildName | ConvertTo-Json -Depth 3
  `;
  const out = await runPS(ps);
  if (!out) return null;
  const list = JSON.parse(out);

  const arr = Array.isArray(list) ? list : list ? [list] : [];
  if (arr.length === 0) return null;

  // Prefer entries that clearly say "TallyPrime", otherwise any "Tally"
  const pick =
    arr.find((x) => /TallyPrime/i.test(x.DisplayName || "")) ||
    arr.find((x) => /Tally/i.test(x.DisplayName || ""));

  if (!pick) return null;

  return {
    source: "registry",
    product: pick.DisplayName || "Tally",
    displayVersion: pick.DisplayVersion || null,
    installLocation: pick.InstallLocation || null,
    registryKey: pick.PSChildName || null,
  };
}

async function getFromRunningProcess() {
  const ps = `
$p = Get-Process -Name 'Tally*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) {
  $ver = (Get-Item $p.Path).VersionInfo.ProductVersion
  [PSCustomObject]@{ Path=$p.Path; Version=$ver } | ConvertTo-Json -Depth 3
}
  `;
  const out = await runPS(ps);
  if (!out) return null;
  const obj = JSON.parse(out);
  if (!obj?.Path) return null;

  return {
    source: "process",
    product: "Tally",
    displayVersion: obj.Version || null,
    exePath: obj.Path,
  };
}

async function getTallyVersionFromRegistry() {
  // 1) Try registry (covers normal installs)
  const reg = await getFromRegistry();

  //   const reg = {
  //     source: "registry",
  //     product: "TallyPrime",
  //     displayVersion: "Series A 6.2.0 Build 27068",
  //     installLocation: "D:\\Program Files\\Tally Prime",
  //     registryKey: "TallyPrime_6.2.0",
  //   };

  if (reg) return reg;

  // 2) Try running process (covers portable installs or missing uninstall keys)
  const proc = await getFromRunningProcess();

  //   const proc = {
  //     source: "process",
  //     product: "Tally",
  //     displayVersion: "1.1.6.2",
  //     exePath: "D:\\Program Files\\Tally Prime\\tally.exe",
  //   };

  if (proc) return proc;

  // 3) Nothing found
  return { error: "Tally not found in registry or process list" };
}

module.exports = getTallyVersionFromRegistry;
