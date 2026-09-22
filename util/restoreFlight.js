let cloudRestoreInFlight = false;

function tryBeginCloudRestore() {
  if (cloudRestoreInFlight) return false;
  cloudRestoreInFlight = true;
  return true;
}

function endCloudRestore() {
  cloudRestoreInFlight = false;
}

function isCloudRestoreInFlight() {
  return cloudRestoreInFlight;
}

function __resetCloudRestoreForTests() {
  cloudRestoreInFlight = false;
}

module.exports = {
  tryBeginCloudRestore,
  endCloudRestore,
  isCloudRestoreInFlight,
  __resetCloudRestoreForTests,
};
