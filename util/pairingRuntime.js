/**
 * Wires the pairing lifecycle to Electron, axios and the renderer.
 *
 * Also owns startup/reconnect reconciliation of the tenant binding: the
 * server-side device→workspace binding is the only authority. A cached
 * workspace id is a display/scoping convenience and can never grant access.
 */
const { info } = require("./logger");
const lifecycle = require("./pairingLifecycle");
const {
  setBoundWorkspaceId,
  clearWorkspaceBinding,
  getSelectedCompanies,
  getPendingSelection,
} = require("./companySelection");

let targetWindow = null;

function emit(key, value) {
  const contents = targetWindow?.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send("window:listener", { key, value });
}

/** Single mapper for the backend pairing-device shape. */
function mapPairedDevice(pairing) {
  if (!pairing) return null;
  return {
    name: pairing.USER_NAME || pairing.NAME || pairing.MOBILE || "Paired Account",
    os: pairing.IS_ANDROID ? "Android" : pairing.IS_PAIRED ? "Mobile" : "Unknown",
    last: pairing.LAST_SYNC_AT,
    mobile: pairing.MOBILE || "",
  };
}

const api = {
  async getPairingCode() {
    const { axiosInstance } = require("./helper");
    const response = await axiosInstance.get("/desktop/pairing-code");
    return response.data;
  },
  async claim() {
    const { axiosInstance } = require("./helper");
    const { claimAndAck } = require("./claimPairing");
    const data = await claimAndAck(axiosInstance);
    // Bind before `pairingClaimed` is emitted: while unbound, a list kept from
    // another workspace reads as the current selection and would be synced.
    await syncWorkspaceBinding(data?.workspace);
    return data;
  },
  async getPairedDevice() {
    const { axiosInstance } = require("./helper");
    const response = await axiosInstance.get("/desktop/pairing-device");
    return mapPairedDevice(response.data?.data?.pairing);
  },
};

/**
 * Resolve the workspace from the server binding and scope local state to it.
 * A selection owned by a different workspace is held back here and the
 * renderer asks the user whether to use it.
 */
async function syncWorkspaceBinding(fallbackWorkspace = null) {
  let profile = null;
  try {
    const { axiosInstance } = require("./helper");
    const response = await axiosInstance.get("/desktop/me");
    profile = response.data?.data || null;
  } catch (err) {
    info(`[pairing] workspace binding lookup failed: ${err?.message}`);
    if (!fallbackWorkspace?.id) return null;
  }
  try {
    const workspace = profile?.workspace?.id ? profile.workspace : fallbackWorkspace;
    if (!workspace?.id) return profile;

    const selectionPending = setBoundWorkspaceId(workspace.id);
    emit("workspace", workspace);
    // Reads return [] until the binding is known, so the renderer may hold a
    // stale empty list; re-send whatever is current now.
    emit("selectedCompanies", getSelectedCompanies());
    if (selectionPending) {
      info("[pairing] workspace changed — previous company selection awaits confirmation");
      emit("companySelectionConfirm", {
        companies: getPendingSelection(),
        workspaceName: workspace.name || null,
      });
    }
    return profile;
  } catch (err) {
    info(`[pairing] workspace binding lookup failed: ${err?.message}`);
    return null;
  }
}

/**
 * Compare local state against the server binding. Backend wins, except when it
 * is unreachable — a transient failure must never look like an unpair.
 */
async function reconcileBinding(reason = "startup") {
  let paired;
  try {
    paired = await api.getPairedDevice();
  } catch (err) {
    info(`[pairing] binding check unreachable (${reason}): ${err?.message}`);
    return { reachable: false, paired: null };
  }

  if (paired) {
    lifecycle.stop("paired");
    emit("pairedDevice", paired);
    await syncWorkspaceBinding();
    return { reachable: true, paired };
  }

  // No server-side binding: this Desktop is genuinely unpaired or was revoked.
  clearWorkspaceBinding();
  emit("pairedDevice", null);
  emit("selectedCompanies", getSelectedCompanies());
  await lifecycle.start(reason);
  return { reachable: true, paired: null };
}

function initPairingRuntime(window) {
  targetWindow = window;
  lifecycle.configure({
    api,
    emit,
    log: (message) => info(message),
  });
}

/** Local teardown after an actual unpair / revoked binding. */
function handleUnpaired(reason = "unpaired") {
  clearWorkspaceBinding();
  emit("selectedCompanies", getSelectedCompanies());
  return lifecycle.start(reason);
}

function handleResume(reason = "resume") {
  return lifecycle.revalidate(reason);
}

module.exports = {
  initPairingRuntime,
  reconcileBinding,
  syncWorkspaceBinding,
  handleUnpaired,
  handleResume,
  mapPairedDevice,
  lifecycle,
};
