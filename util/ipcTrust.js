/**
 * Every IPC handler in this app is privileged (store, Tally, backups, files, pairing).
 * Wraps ipcMain so a handler runs only for the top-level frame of a trusted renderer
 * page; anything else is refused before the handler (and any file/process access) runs.
 * Install once, before any handler is registered.
 */
class UntrustedSenderError extends Error {
  constructor(channel) {
    super(`IPC ${channel} refused: untrusted sender`);
    this.code = "IPC_UNTRUSTED_SENDER";
  }
}

function senderIsTrusted(event, isTrustedUrl) {
  const frame = event?.senderFrame;
  if (!frame || typeof frame.url !== "string") return false;
  if (frame.parent) return false; // subframes never get privileged IPC
  const top = event?.sender?.mainFrame;
  if (top && top !== frame) return false;
  return isTrustedUrl(frame.url);
}

/**
 * @param {object} [channelUrlPolicy] channel → (url) => boolean for the few channels a
 *   non-app page may use (the renderer-recovery status page is a data: URL).
 */
function installIpcSenderCheck(ipcMain, isTrustedUrl, log = () => {}, channelUrlPolicy = {}) {
  if (ipcMain.__senderCheckInstalled) return;
  const handle = ipcMain.handle.bind(ipcMain);
  const on = ipcMain.on.bind(ipcMain);
  const allowedFor = (channel) => {
    const extra = channelUrlPolicy[channel];
    return extra ? (url) => isTrustedUrl(url) || extra(url) : isTrustedUrl;
  };
  ipcMain.handle = (channel, fn) =>
    handle(channel, (event, ...args) => {
      if (!senderIsTrusted(event, allowedFor(channel))) {
        log(`[security] refused IPC ${channel}`, { url: event?.senderFrame?.url || null });
        throw new UntrustedSenderError(channel);
      }
      return fn(event, ...args);
    });
  ipcMain.on = (channel, fn) =>
    on(channel, (event, ...args) => {
      if (!senderIsTrusted(event, allowedFor(channel))) {
        log(`[security] refused IPC ${channel}`, { url: event?.senderFrame?.url || null });
        return;
      }
      return fn(event, ...args);
    });
  ipcMain.__senderCheckInstalled = true;
}

/** Help → attach files: only a plain open-file dialog, whatever the renderer asks for. */
function safeOpenFileOptions(options) {
  const props = Array.isArray(options?.properties) ? options.properties : [];
  const filters = Array.isArray(options?.filters)
    ? options.filters
        .filter((f) => f && typeof f.name === "string" && Array.isArray(f.extensions))
        .slice(0, 5)
        .map((f) => ({ name: f.name.slice(0, 60), extensions: f.extensions.filter((e) => /^[a-z0-9]{1,8}$/i.test(e)).slice(0, 10) }))
    : [];
  return {
    title: typeof options?.title === "string" ? options.title.slice(0, 80) : undefined,
    properties: ["openFile", ...(props.includes("multiSelections") ? ["multiSelections"] : [])],
    filters,
  };
}

module.exports = { installIpcSenderCheck, senderIsTrusted, safeOpenFileOptions, UntrustedSenderError };
