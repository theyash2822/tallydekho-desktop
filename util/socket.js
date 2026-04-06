const getDeviceProfile = require("./deviceProfile");
const { checkForUpdates } = require("./helper");
const { info, error } = require("./logger");
const store = require("./store.js");
const { postToTally } = require("./xml");

module.exports = (window, socket) => {
  // const socketId = socket.id;

  // socket.onAny((event, ...args) => {
  //   info(`[client] got event: ${event}`, args);
  // });

  socket.on("connect", () => {
    info(`[socket] connected ${socket.id}`);
    registerDevice(socket);
  });

  socket.on("reconnect", (attempt) => {
    info(`[socket] reconnected after ${attempt} attempts ${socket.id}`);
    registerDevice(socket);
  });

  socket.on("connect_error", (err) => {
    info("[socket] connect_error", err && err.message ? err.message : err);
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

  // tally:write - receive XML from backend and forward to Tally HTTP port
  // Backend sends: { jobId, xml, companyName }
  // Desktop POSTs to Tally and acks back with result
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
    } catch (err) {
      error(err?.message, "tally:write");
      const response = { status: false, message: err?.message, jobId };
      if (typeof callback === "function") callback(response);
      socket.emit("tally:write:result", response);
    }
  });

  const registerDevice = (socket) => {
    const deviceId = getDeviceProfile().deviceId;
    socket.emit("register", { type: "desktop", deviceId });
  };
};
