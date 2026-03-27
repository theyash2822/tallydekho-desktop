// Pairing helpers.  Generates six‑digit codes for pairing the
// desktop agent with the mobile app.  The random code is returned as
// a string to preserve leading zeros.

export function generatePairingCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}