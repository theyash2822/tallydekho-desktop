/**
 * Keeps the main window usable when its page fails to load (e.g. -331
 * ERR_NETWORK_IO_SUSPENDED after Windows sleeps mid-load): retries with backoff,
 * retries immediately on wake/unlock, and only then shows a page with Reload / Quit.
 * Only the window's page is reloaded — sync, backup and Tally work in the main
 * process are untouched.
 */

const RETRY_DELAYS_MS = [2000, 5000, 10000];
// -3 ERR_ABORTED: a load replaced on purpose (including by our own status page).
const IGNORED_CODES = new Set([-3]);

const isStatusPage = (url) => typeof url === "string" && url.startsWith("data:");

function createRendererRecovery({
  load,
  showStatus,
  schedule = setTimeout,
  cancel = clearTimeout,
  log = () => {},
  delays = RETRY_DELAYS_MS,
}) {
  let attempt = 0;
  let timer = null;
  let broken = false;
  let lastError = null;
  // Chromium follows did-fail-load with did-finish-load for its internal error
  // page (same URL); that finish must not count as a recovery.
  let errorPageUrl = null;

  const reload = () => {
    timer = null;
    errorPageUrl = null;
    load();
  };

  return {
    /** @returns {"ignored"|"pending"|"retry"|"failed"} */
    onFailLoad({ code, desc, url, isMainFrame }) {
      if (!isMainFrame || IGNORED_CODES.has(code) || isStatusPage(url)) return "ignored";
      broken = true;
      lastError = { code, desc };
      errorPageUrl = url || null;
      if (timer) return "pending";
      if (attempt < delays.length) {
        const delay = delays[attempt++];
        log("retry", { code, desc, attempt, delayMs: delay });
        showStatus({ state: "retrying", attempt, total: delays.length, code, desc });
        timer = schedule(reload, delay);
        return "retry";
      }
      log("failed", { code, desc });
      showStatus({ state: "failed", code, desc });
      return "failed";
    },

    onLoaded(url) {
      if (isStatusPage(url)) return;
      if (errorPageUrl && url === errorPageUrl) {
        errorPageUrl = null;
        return;
      }
      if (broken) log("recovered", { attempts: attempt });
      attempt = 0;
      broken = false;
      lastError = null;
    },

    /** Wake / unlock / Reload button. No-op while the real page is healthy. */
    retryNow(reason) {
      if (!broken) return false;
      if (timer) cancel(timer);
      timer = null;
      attempt = 0;
      errorPageUrl = null;
      log("retry_now", { reason, ...(lastError || {}) });
      load();
      return true;
    },

    isBroken: () => broken,
  };
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function statusPageHtml({ state, attempt, total, code, desc }) {
  const retrying = state === "retrying";
  const title = retrying ? "Reconnecting TallyDekho…" : "TallyDekho couldn't open its screen";
  const body = retrying
    ? `Trying again automatically (${Number(attempt) || 1} of ${Number(total) || 1}).`
    : "This usually happens after the PC wakes from sleep or the network drops. Your sync and backups are not affected.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>TallyDekho</title><style>
html,body{margin:0;height:100%;font-family:"Segoe UI",system-ui,sans-serif;background:#f4f8fc;color:#1f2937}
.bar{height:32px;-webkit-app-region:drag}
.wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:calc(100% - 64px);padding:0 48px;text-align:center}
h1{font-size:20px;margin:0 0 10px}p{font-size:14px;line-height:1.5;margin:0 0 22px;color:#4b5563;max-width:520px}
.btns{display:flex;gap:12px}button{font:inherit;font-size:14px;padding:9px 22px;border-radius:8px;cursor:pointer;border:1px solid #2563eb}
.primary{background:#2563eb;color:#fff}.secondary{background:#fff;color:#2563eb}
.code{position:fixed;bottom:10px;left:0;right:0;text-align:center;font-size:11px;color:#9ca3af}
</style></head><body><div class="bar"></div><div class="wrap">
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>
<div class="btns"><button class="primary" onclick="window.api&&window.api.recoverRenderer('reload')">Reload</button>
<button class="secondary" onclick="window.api&&window.api.recoverRenderer('quit')">Quit</button></div>
</div><div class="code">Error ${escapeHtml(code)} ${escapeHtml(desc)}</div></body></html>`;
}

const statusPageUrl = (status) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(statusPageHtml(status))}`;

module.exports = {
  RETRY_DELAYS_MS,
  createRendererRecovery,
  statusPageHtml,
  statusPageUrl,
};
