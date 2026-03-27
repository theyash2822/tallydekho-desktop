// In the original TypeScript project this file defined interfaces
// such as `Company` to provide strong typing across screens.  For
// the JavaScript port we omit these definitions entirely because
// JavaScript does not perform static type checking.  This module
// remains as a placeholder should you wish to export runtime
// constants or helper functions in the future.

// If you need to define shapes of objects for documentation purposes
// you can use JSDoc comments.  For example:
//
// /**
//  * A Company record from the backend.
//  * @typedef {Object} Company
//  * @property {string} id - Unique identifier for the company
//  * @property {string} name - Human friendly company name
//  * @property {string} guid - Globally unique identifier used by Tally
//  * @property {string} path - Path to the Tally data directory
//  * @property {'connected'|'disconnected'|'paused'|'error'|string} status - Current sync status
//  * @property {Date|null} last - Timestamp of the last successful sync
//  * @property {boolean} enabled - Whether sync is enabled for this company
//  * @property {number} entities - Number of ledgers/entities tracked
//  */