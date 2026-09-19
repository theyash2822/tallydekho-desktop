const getDeviceProfile = require("./deviceProfile");
const { checkForUpdates } = require("./helper");
const { info, error } = require("./logger");
const store = require("./store.js");
const { postToTally, fetchAndIngestSingleVouchers } = require("./xml");
const { getSelectedCompanies } = require("./companySelection");
const {
  processCompanyWriteback,
  reconcilePendingWriteback,
} = require("./writeback");

module.exports = (window, socket) => {
  // const socketId = socket.id;

  // socket.onAny((event, ...args) => {
  //   info(`[client] got event: ${event}`, args);
  // });

  /**
   * Connectivity returned: re-check the pairing session against wall-clock
   * time and pull any writeback wake-up that was emitted while we were away.
   */
  const onConnectivityRestored = (reason) => {
    const { reconcileBinding, handleResume } = require("./pairingRuntime");
    handleResume(reason);
    reconcileBinding(reason).then((result) => {
      if (result.paired) reconcilePendingWriteback(reason);
    });
  };

  socket.on("connect", () => {
    info(`[socket] connected ${socket.id}`);
    registerDevice(socket);
    onConnectivityRestored("socket-connect");
  });

  socket.on("reconnect", (attempt) => {
    info(`[socket] reconnected after ${attempt} attempts ${socket.id}`);
    registerDevice(socket);
    onConnectivityRestored("socket-reconnect");
  });

  socket.on("connect_error", (err) => {
    const { baseURL: url } = require("./helper");
    info(
      "[socket] connect_error",
      `${err && err.message ? err.message : err} baseURL=${url}`
    );
  });

  socket.on("reconnect_attempt", (attempt) => {
    info(`[socket] reconnect_attempt ${attempt}`);
  });

  socket.on("disconnect", (reason) => {
    info("[socket] disconnected", reason);
  });

  socket.on("subscribe", (payload) => {
    info("[subscribe socket]", payload);
    if (window && window.webContents) {
      window.webContents.send("window:listener", payload);
    }
  });

  socket.on("syncing", (payload, cb) => {
    info("[sync status socket]: ", payload);
    if (typeof cb === "function") cb({ receivedAt: Date.now() });

    const uploadId = store.get("uploadId");
    if (uploadId != payload?.data?.uploadId) {
      info(`Upload Id : "${uploadId}" mismatch : "${payload?.data?.uploadId}"`);
      return;
    }

    if (window && window.webContents) {
      const body = {};
      if (!payload.status) {
        body.key = "syncingCurrentStatus";
        body.value = {
          message: payload.message,
          code: payload.data?.code,
        };
      } else {
        body.key = "syncMessage";
        body.value = "Sync Complete";
      }
      info("[sync status body]: ", body);
      window.webContents.send("window:listener", body);
      // Reset syncing state after completion
      if (payload.status) {
        window.webContents.send("window:listener", { key: "isSyncing", value: false });
        window.webContents.send("window:listener", { key: "syncProgress", value: 100 });
      }
    }
  });

  socket.on("update_available", () => {
    info("[update_available socket]");
    window && window.webContents && checkForUpdates(window);
  });

  // Mobile or web portal unpaired this desktop.
  socket.on("unpaired", () => {
    info("[socket] unpaired — clearing pairing state");
    try {
      require("./pairingSessionState").clearPairingSession();
      store.delete("workspace");
    } catch (_) {}

    if (window && window.webContents) {
      window.webContents.send("window:listener", { key: "isSyncing", value: false });
      window.webContents.send("window:listener", { key: "syncProgress", value: 0 });
      window.webContents.send("window:listener", { key: "pairedDevice", value: null });
      window.webContents.send("window:listener", { key: "pairingCode", value: null });
      window.webContents.send("window:listener", { key: "unpairedAlert", value: true });
    }
    store.set("isSyncing", false);
    const { clearDeviceSecret } = require("./deviceCredential");
    clearDeviceSecret();
    // Drops the workspace binding and its company selection, then starts a
    // fresh pairing session automatically.
    require("./pairingRuntime").handleUnpaired("unpaired-event");
  });

  // tally:write - receive XML from backend and forward to Tally HTTP port
  // Backend sends: { jobId, xml, companyName }
  // Desktop POSTs to Tally and acks back with result
  // LEGACY-BLOCK: pairing_confirmed delivers the device secret straight over the
  // socket. Superseded by pairing_approved + HTTP claim/ack, kept only while an
  // older backend may still emit it. No new code may depend on this path.
  // Deletion prerequisite: confirm no deployed backend emits `pairing_confirmed`.
  socket.on("pairing_confirmed", async (payload) => {
    info("[socket] pairing_confirmed (legacy path)");
    try {
      const { axiosInstance } = require("./helper");
      const { saveDeviceSecret } = require("./deviceCredential");
      const { lifecycle, reconcileBinding } = require("./pairingRuntime");

      if (payload?.deviceSecret) {
        saveDeviceSecret(payload.deviceSecret);
        await axiosInstance.post("/desktop/claim-credential").catch(() => {});
      } else {
        // Route through the lifecycle so this cannot race the claim poll.
        await lifecycle.claimNow("pairing_confirmed");
      }
      await reconcileBinding("pairing_confirmed");
      if (payload?.workspace) {
        window.webContents.send("window:listener", { key: "workspace", value: payload.workspace });
      }
    } catch (e) {
      error(e?.message, "pairing_confirmed");
    }
  });

  // pairing_approved — wake-up only. The claim itself runs through the
  // lifecycle's single-flight guard, so socket and poll can never both claim.
  socket.on("pairing_approved", async (payload) => {
    info("[socket] pairing_approved", payload?.sessionId || "");
    try {
      const { getPairingSession } = require("./pairingSessionState");
      const { lifecycle } = require("./pairingRuntime");

      const current = getPairingSession();
      if (
        payload?.sessionId &&
        current.sessionId &&
        String(payload.sessionId) !== String(current.sessionId)
      ) {
        info("[socket] pairing_approved for a superseded session — ignored");
        return;
      }
      await lifecycle.claimNow("pairing_approved");
    } catch (e) {
      error(e?.message, "pairing_approved");
    }
  });

  socket.on("hard_sync_approved", (payload) => {
    window?.webContents?.send("window:listener", { key: "hardSyncApproved", value: payload });
  });
  socket.on("restore_approved", async (payload) => {
    window?.webContents?.send("window:listener", { key: "restoreApproved", value: payload });
    try {
      const { startCloudRestore } = require("./restoreBackup");
      await startCloudRestore(window?.webContents || window);
    } catch (err) {
      error(err?.message, "restore_approved");
    }
  });
  // This Desktop was replaced or revoked server-side: drop every piece of local
  // tenant state so a stale cache can never keep acting for the old workspace.
  socket.on("binding_revoked", (payload) => {
    const { clearDeviceSecret } = require("./deviceCredential");
    clearDeviceSecret();
    try {
      require("./pairingSessionState").clearPairingSession();
    } catch (_) {}
    store.delete("workspace");
    store.set("isSyncing", false);
    window?.webContents?.send("window:listener", { key: "bindingRevoked", value: payload || true });
    require("./pairingRuntime").handleUnpaired("binding-revoked");
  });

  socket.on("hard_sync_rejected", (payload) => {
    window?.webContents?.send("window:listener", { key: "hardSyncRejected", value: payload });
  });

  // sync:request - backend asks desktop to pull latest data (e.g. after a voucher write)
  // to reconcile the Tally-assigned voucher number back into app_vouchers.
  //
  // Phase 2a (2026-06-30): payload may include tallyIds (MASTERIDs) + companyName + companyGuid.
  // Phase 2b (2026-07-02): if tallyIds present AND companyGuid matches a currently
  // paired/selected company, fetch ONLY those vouchers via SingleVoucher.xml
  // (fast, targeted). Silent fallback to full sync on any failure or missing
  // preconditions. Auto/Manual/Hard sync paths are NOT affected.
  socket.on("sync:request", async (payload) => {
    const reason      = payload?.reason || '';
    const tallyIds    = Array.isArray(payload?.tallyIds) ? payload.tallyIds.filter(Boolean) : [];
    const companyName = payload?.companyName || null;
    const companyGuid = payload?.companyGuid || null;
    info('[sync:request] received from backend', reason, 'tallyIds:', tallyIds.join(',') || '(none)');

    if (store.get('isSyncing')) {
      info('[sync:request] already syncing — current sync will pick up new voucher(s)');
      return;
    }
    const selectedCompanies = getSelectedCompanies();
    if (!selectedCompanies.length) {
      info('[sync:request] no selected companies — skipping');
      return;
    }

    // Phase 2b: try targeted single-voucher fetch first if we have everything we need
    // AND the requested company is one this desktop is paired to (safety net for
    // multi-tenant / stale-socket edge cases).
    const companyMatches = companyGuid && selectedCompanies.some(c => c?.guid === companyGuid);
    const canTargetedFetch = tallyIds.length && companyName && companyGuid && companyMatches;

    if (canTargetedFetch) {
      try {
        const result = await fetchAndIngestSingleVouchers({ companyName, companyGuid, tallyIds });
        if (result?.status) {
          info(`[sync:request] targeted SingleVoucher.xml fetch OK — ${result.count} row(s) ingested`);
          return; // done — no full sync needed
        }
        info('[sync:request] targeted fetch failed, falling back to full sync:', result?.message);
      } catch (err) {
        error(err?.message, 'sync:request.targeted');
        info('[sync:request] targeted fetch threw, falling back to full sync');
      }
    } else if (tallyIds.length) {
      // We got tallyIds but couldn't use the targeted path — log why for debugging.
      info('[sync:request] targeted path skipped:',
        !companyName ? 'no companyName' :
        !companyGuid ? 'no companyGuid' :
        !companyMatches ? `companyGuid ${companyGuid} not in selectedCompanies` :
        'unknown');
    }

    // Fallback — trigger a full post-write sync via IPC to the renderer.
    if (window && window.webContents) {
      window.webContents.send('window:listener', { key: 'triggerPostWriteSync', value: Date.now() });
      info('[sync:request] triggered full post-write sync (fallback path)');
    }
  });

  // Event-driven writeback. A wake-up emitted while Desktop was offline is
  // never redelivered, so `reconcilePendingWriteback` covers that case on
  // startup and on every connectivity restore.
  socket.on("pending_tally_writeback_available", async (payload) => {
    const { companyGuid, count } = payload || {};
    if (!companyGuid || !count) return;
    await processCompanyWriteback(companyGuid);
  });

  socket.on("tally:write", async (payload, callback) => {
    const { jobId, xml } = payload || {};
    info("[tally:write] received job", { jobId, xmlLength: xml?.length });

    if (!xml) {
      const result = { status: false, message: "No XML provided", jobId };
      if (typeof callback === "function") callback(result);
      socket.emit("tally:write:result", result);
      return;
    }

    try {
      const result = await postToTally(xml);
      const response = { ...result, jobId };
      info("[tally:write] result", { jobId, status: result.status });
      if (typeof callback === "function") callback(response);
      socket.emit("tally:write:result", response);

      // After a successful write, trigger a lightweight sync so Tally's auto-assigned
      // voucher number gets pulled back and stored in app_vouchers via ingestProcessor.
      // Delay 2s to let Tally finish numbering the entry before the sync pull.
      if (result.status === true) {
        setTimeout(() => {
          if (store.get('isSyncing')) return; // ongoing sync will pick it up
          const selectedCompanies = getSelectedCompanies();
          if (selectedCompanies.length > 0) {
            info('[tally:write] triggering post-write sync to capture voucher number');
            window.webContents.send('window:listener', { key: 'triggerPostWriteSync', value: Date.now() });
          }
        }, 2000);
      }
    } catch (err) {
      error(err?.message, "tally:write");
      const response = { status: false, message: err?.message, jobId };
      if (typeof callback === "function") callback(response);
      socket.emit("tally:write:result", response);
    }
  });

  const registerDevice = (socket) => {
    const deviceId = getDeviceProfile().deviceId;
    socket.emit("register", { type: "desktop", deviceId, deviceSecret: require("./deviceCredential").getDeviceSecret() });
  };
};
