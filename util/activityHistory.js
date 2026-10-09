/** Backup/restore activity shown in the UI: newest first, at most MAX_ACTIVITY entries.
 *  Only this display list is trimmed; backups and schedule metadata live in other keys. */
const MAX_ACTIVITY = 100;

const boundActivity = (list) => (Array.isArray(list) ? list.slice(0, MAX_ACTIVITY) : []);

module.exports = { MAX_ACTIVITY, boundActivity };
