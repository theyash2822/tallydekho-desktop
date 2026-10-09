const store = require("./store.js");

/** One version rule for manual, scheduled, headless, post-pair and socket single-voucher work. */
const versionPolicy = () => {
  const level = Number(store.get("versionLevel") || 0);
  if (level >= 2) {
    return { code: "version_blocked", message: store.get("versionMessage") || "Update required to sync" };
  }
  return null;
};

module.exports = { versionPolicy };
