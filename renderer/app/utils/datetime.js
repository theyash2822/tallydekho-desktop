// Utility functions lifted directly from the original project.  They
// convert Date objects into user‑friendly strings.  Note that the
// locale is fixed to en-GB so that the day/month ordering matches
// the original specification.

export function formatDateTime(date) {
  const options = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  return new Intl.DateTimeFormat("en-GB", options).format(date);
}

export function formatDate(date) {
  const options = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  };
  return new Intl.DateTimeFormat("en-GB", options).format(date);
}
