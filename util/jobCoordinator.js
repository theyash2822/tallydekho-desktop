/**
 * Single owner of long-running Desktop operations (sync, backup, restore, …).
 *
 * - admit() checks conflicts and claims the slot synchronously, before any await,
 *   so two triggers can never both start the same kind of work.
 * - Each job carries its own AbortController and cancellation state. Code running
 *   inside run() can read the current job through AsyncLocalStorage, so a Tally
 *   request failing inside a sync marks *that* sync, while a health probe running
 *   outside any job cannot cancel it.
 * - Only the job itself releases its slot; a rejected start never touches the
 *   running job.
 */
const { AsyncLocalStorage } = require("async_hooks");
const { EventEmitter } = require("events");
const crypto = require("crypto");

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "partial", "rejected", "deferred"]);

const EXCLUSIVE = ["restore", "tally_restart"];
const SOURCE = ["sync", "hard_sync"];

/** Which active job types block a new job of the given type. */
const CONFLICTS = {
  sync: [...SOURCE, ...EXCLUSIVE, "backup", "company_removal"],
  hard_sync: [...SOURCE, ...EXCLUSIVE, "backup", "company_removal", "single_voucher"],
  single_voucher: [...SOURCE, ...EXCLUSIVE, "single_voucher"],
  backup: [...SOURCE, ...EXCLUSIVE, "backup"],
  restore: [...SOURCE, ...EXCLUSIVE, "backup", "single_voucher", "company_removal"],
  tally_restart: [...SOURCE, ...EXCLUSIVE, "backup", "single_voucher"],
  company_removal: [...SOURCE, ...EXCLUSIVE, "company_removal"],
};

const BUSY_MESSAGES = {
  sync: "A sync is already in progress on this Desktop.",
  hard_sync: "A hard sync is already in progress on this Desktop.",
  single_voucher: "A voucher refresh is in progress. Try again in a moment.",
  backup: "A backup is in progress. Try again when it finishes.",
  restore: "A restore is in progress. Try again when it finishes.",
  tally_restart: "Tally is being restarted. Try again in a moment.",
  company_removal: "A company is being removed. Try again in a moment.",
};

class CancelledError extends Error {
  constructor(code = "cancelled") {
    super("Operation cancelled");
    this.name = "CancelledError";
    this.code = code;
  }
}

function createCoordinator({ now = () => Date.now(), maxHistory = 20 } = {}) {
  const events = new EventEmitter();
  const als = new AsyncLocalStorage();
  const active = new Map();
  const history = [];

  function publicView(job) {
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      trigger: job.trigger,
      scope: job.scope,
      state: job.state,
      cancelRequested: job.cancelRequested,
      cancelCode: job.cancelCode,
      sourceFailure: job.sourceFailure,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      result: job.result,
    };
  }

  function emit(job) {
    events.emit("change", publicView(job), snapshot());
  }

  function conflictFor(type) {
    const blockers = CONFLICTS[type];
    if (!blockers) throw new Error(`unknown job type: ${type}`);
    for (const job of active.values()) {
      if (blockers.includes(job.type)) return job;
    }
    return null;
  }

  function admit(type, { scope = null, trigger = "manual", policy } = {}) {
    const blocker = conflictFor(type);
    if (blocker) {
      return {
        accepted: false,
        code: blocker.type === type || (SOURCE.includes(blocker.type) && SOURCE.includes(type))
          ? "JOB_ALREADY_RUNNING"
          : "JOB_CONFLICT",
        message: BUSY_MESSAGES[blocker.type] || "Another operation is in progress.",
        activeJob: publicView(blocker),
      };
    }
    if (typeof policy === "function") {
      const refusal = policy(type, { scope, trigger });
      if (refusal) return { accepted: false, ...refusal, activeJob: null };
    }
    const controller = new AbortController();
    const job = {
      id: crypto.randomUUID(),
      type,
      trigger,
      scope,
      state: "preparing",
      cancelRequested: false,
      cancelCode: null,
      sourceFailure: null,
      startedAt: now(),
      finishedAt: null,
      result: null,
      controller,
      signal: controller.signal,
      setState(state) {
        if (TERMINAL_STATES.has(job.state) || job.state === state) return;
        if (job.cancelRequested && state !== "cancelled") return;
        job.state = state;
        emit(job);
      },
      isCancelled() {
        return job.cancelRequested;
      },
      throwIfCancelled() {
        if (job.cancelRequested) throw new CancelledError(job.cancelCode || "cancelled");
      },
      /** A required source request failed; the job should stop issuing work. */
      recordSourceFailure(code) {
        if (!job.sourceFailure) job.sourceFailure = code;
      },
      stopCode() {
        return job.cancelRequested ? job.cancelCode || "cancelled" : job.sourceFailure;
      },
    };
    active.set(job.id, job);
    emit(job);
    return { accepted: true, job };
  }

  function finish(job, { state, result = null } = {}) {
    if (!job || active.get(job.id) !== job) return false;
    const finalState = job.cancelRequested && state !== "succeeded" && state !== "partial"
      ? "cancelled"
      : state || "succeeded";
    job.state = TERMINAL_STATES.has(finalState) ? finalState : "failed";
    job.result = result;
    job.finishedAt = now();
    active.delete(job.id);
    history.unshift(publicView(job));
    history.length = Math.min(history.length, maxHistory);
    emit(job);
    return true;
  }

  /**
   * Admit, run `fn(job)` with the job as async context, and always release.
   * `fn` returns `{ state, result }` or a plain result (treated as succeeded).
   */
  async function run(type, opts, fn) {
    const admission = admit(type, opts);
    if (!admission.accepted) return admission;
    return execute(admission.job, fn);
  }

  /** Run an already-admitted job to completion and release it. */
  async function execute(job, fn) {
    let outcome;
    try {
      outcome = await als.run(job, () => fn(job));
    } catch (err) {
      if (err instanceof CancelledError || job.cancelRequested) {
        finish(job, { state: "cancelled", result: { code: job.cancelCode || "cancelled" } });
        return { accepted: true, job: publicView(job), result: job.result };
      }
      finish(job, { state: "failed", result: { code: err?.code || "JOB_FAILED", message: err?.message } });
      return { accepted: true, job: publicView(job), result: job.result, error: err };
    }
    const shaped = outcome && typeof outcome === "object" && "state" in outcome && "result" in outcome
      ? outcome
      : { state: "succeeded", result: outcome };
    finish(job, shaped);
    return { accepted: true, job: publicView(job), result: job.result };
  }

  /** Request cancellation of active jobs matching id and/or types. Does not release them. */
  function requestCancel({ jobId = null, types = null, code = "manually_stopped" } = {}) {
    const touched = [];
    for (const job of active.values()) {
      if (jobId && job.id !== jobId) continue;
      if (types && !types.includes(job.type)) continue;
      if (!job.cancelRequested) {
        job.cancelRequested = true;
        job.cancelCode = code;
        job.state = "cancel_requested";
        try {
          job.controller.abort(new CancelledError(code));
        } catch (_) { /* ignore */ }
        emit(job);
      }
      touched.push(publicView(job));
    }
    return { ok: touched.length > 0, jobs: touched };
  }

  function current() {
    return als.getStore() || null;
  }

  function isActive(types) {
    const list = Array.isArray(types) ? types : [types];
    for (const job of active.values()) if (list.includes(job.type)) return true;
    return false;
  }

  function wouldConflict(type) {
    return !!conflictFor(type);
  }

  function activeJob(types) {
    const list = Array.isArray(types) ? types : [types];
    for (const job of active.values()) if (list.includes(job.type)) return job;
    return null;
  }

  function snapshot() {
    return {
      active: Array.from(active.values()).map(publicView),
      recent: history.slice(0, 5),
    };
  }

  return {
    admit,
    finish,
    run,
    execute,
    requestCancel,
    current,
    isActive,
    wouldConflict,
    activeJob,
    snapshot,
    publicView,
    onChange: (cb) => {
      events.on("change", cb);
      return () => events.off("change", cb);
    },
  };
}

const coordinator = createCoordinator();

module.exports = {
  coordinator,
  createCoordinator,
  CancelledError,
  TERMINAL_STATES,
  CONFLICTS,
};
