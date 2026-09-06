/**
 * =========================================================================
 * AUDIT LOG (WRITE-BEFORE-ACT ACCOUNTABILITY)
 * =========================================================================
 * Append-only JSONL record of every side-effecting action the server
 * takes, written to var/logs/audit.jsonl through paths.mjs.
 *
 * The invariant this module exists to enforce: a live write must NEVER
 * happen unless the audit log is provably writable. Accountability that
 * is best-effort is not accountability. If the log can fail silently,
 * the ABSENCE of a record proves nothing, and the log is worthless in
 * exactly the incident you built it for. Making unwritability a refusal
 * to act converts a silent logging failure into a loud, safe outage:
 * the server stops doing damage it cannot account for.
 *
 * FAIL CLOSED: `refuseIfUnauditable()` is the one intentional throw in
 * this file. Everything else returns `{ ok, reason }` so callers can
 * branch, because a logging problem discovered AFTER the effect must not
 * masquerade as a failure of the effect itself.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";
import { createPaths, ROOT } from "./paths.mjs";
import { redactAuth, redactString } from "./util.mjs";

// The live log. Archives are this name plus ".1", ".2", ... See
// `rotateIfNeeded` for why the numbering runs oldest-highest.
const AUDIT_FILE = "audit.jsonl";

// Rotate at roughly 1 MB and keep 3 ARCHIVES, so at most 4 files exist
// (audit.jsonl plus .1 through .3). Stated in archives, NOT in "total
// files", because the ambiguity of "keep 3" is how an operator ends up
// with one fewer generation of history than they sized the disk for.
const MAX_BYTES = 1024 * 1024;
const KEEP_ARCHIVES = 3;

// How long a successful writability probe is trusted before it is redone.
// Deliberately a SHORT TTL and NOT a once-per-process memo: a long-lived
// stdio server can outlive the condition it checked at boot. A mid-run ACL
// change, a filesystem remounted read-only, or a disk that filled up an
// hour after startup must be noticed within seconds, or the invariant
// silently degrades to "the log was writable once".
const WRITABLE_TTL_MS = 5000;

/**
 * Thrown by `refuseIfUnauditable()`. A distinct type (not a bare Error) so
 * a dispatcher can tell "we refused to act because we could not account
 * for it" apart from "the action itself failed", which are opposite
 * situations for an operator: one means nothing happened, the other means
 * something may have.
 */
export class AuditUnavailableError extends Error {
  constructor(reason) {
    super(`Refusing to act: audit log is not writable (${reason})`);
    this.name = "AuditUnavailableError";
    this.code = "AUDIT_UNAVAILABLE";
    this.reason = reason;
  }
}

/**
 * Recursively sort object keys so the same logical payload always
 * serializes to the same bytes.
 *
 * WHY this matters for the hash: the whole point of storing a digest is
 * "action X happened to resource Y with exactly this payload", for dispute
 * resolution and replay detection. JSON.stringify preserves INSERTION
 * order, so two call sites building the same payload with their keys in a
 * different order would produce two different digests, and a replay would
 * read as a new and distinct action. Canonicalizing first removes that.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

/**
 * Redact a value: operator-named keys first, then the shared pattern scrub.
 *
 * Two passes because they catch different things. The key pass blanks fields
 * the operator named in MCP_AUDIT_REDACT_EXTRA, which is how you catch a
 * secret whose name only your API knows. The pattern pass is the shared
 * scrubber in util.mjs and catches credentials by shape wherever they sit,
 * including inside another field's prose.
 *
 * The pattern scrub is REACHED, never copied. A second copy of those regexes
 * is correct exactly until someone tightens the originals, at which point the
 * audit log becomes the one place still writing the secret. ONE redaction
 * implementation, always.
 */
function redact(value) {
  if (value === null || value === undefined) return "null";

  // Blank out any argument whose NAME is on the operator's redact list before
  // the generic pattern scrub runs. Pattern matching catches credentials that
  // look like credentials; this catches the ones that do not, because only the
  // operator knows that their API calls it `passphrase`. Widen-only, so the
  // list can be extended but never narrowed below the in-code defaults.
  const byKey = blankListedKeys(canonicalize(value), CONFIG.AUDIT_REDACT_KEYS);

  // Then the shared pattern scrub from util.mjs. Reached directly rather than
  // through errDetail: this is an ordinary value, not a thrown error, and
  // building a fake `{ response: { data } }` envelope just to borrow the
  // redaction was a workaround, not a design.
  //
  // A string stays a string. Wrapping it in JSON.stringify would quote and
  // escape it, which changes the digest of every string payload and makes a
  // record written before this line unreconcilable with one written after.
  return typeof byKey === "string"
    ? redactString(byKey)
    : JSON.stringify(redactAuth(byKey));
}

// Recursive key blanking. Case-insensitive because an operator who lists
// "apiKey" means to catch "apikey" and "APIKey" too, and a redaction that
// depends on getting the casing right is a redaction that will miss.
function blankListedKeys(value, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return value;
  const wanted = new Set(keys.map((k) => String(k).toLowerCase()));
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const out = {};
    for (const [k, inner] of Object.entries(v)) {
      out[k] = wanted.has(k.toLowerCase()) ? "[redacted]" : walk(inner);
    }
    return out;
  };
  return walk(value);
}

/**
 * SHA-256 of the REDACTED payload, hex. This is what lands in the record.
 *
 * WHY a hash and never the payload: the digest still proves "action X
 * happened to resource Y with exactly this payload" when someone later
 * produces the payload they claim was sent, and it still detects a replay
 * of an identical body. Storing the payload itself would turn the audit
 * log into a second copy of every sensitive value the rest of the server
 * was careful to redact, sitting in a file that is by design append-only,
 * long-lived, and shipped to whoever collects logs.
 *
 * IMPORTANT: redaction runs BEFORE hashing, not after. Hashing the raw
 * value and redacting the hash is meaningless, and it would also mean two
 * requests differing only in a bearer token hash differently, leaking the
 * token's presence as a distinguisher.
 */
function hashPayload(payload) {
  return createHash("sha256").update(redact(payload), "utf8").digest("hex");
}

/**
 * Build an audit log bound to a storage root, a clock and an id source.
 *
 * Follows the `createPaths(root, { rename })` shape in paths.mjs: a factory
 * for tests and for callers with their own root, plus bound default
 * functions at the bottom of this file for normal use.
 */
export function createAuditLog(root = ROOT, {
  now = () => new Date(),
  newId = randomUUID,
  maxBytes = MAX_BYTES,
  keep = KEEP_ARCHIVES,
  ttlMs = WRITABLE_TTL_MS,
} = {}) {
  // Built here, but NOT resolved here. `createPaths` does no I/O at
  // construction; `logPath()` does. Resolving the audit path at module load
  // would move a directory-creation failure to import time, where it takes
  // the process down before any preflight or alert can report it, which is
  // the same trap paths.mjs documents in its own header.
  const paths = createPaths(root);

  // Memoized probe result: { at, result }. `at` is milliseconds from the
  // INJECTED clock, so a test can advance time instead of sleeping.
  let cached = null;

  /**
   * Report whether the audit log can actually be written right now.
   */
  function auditWritable() {
    const nowMs = now().getTime();
    if (cached && nowMs - cached.at < ttlMs) return cached.result;
    const result = probe();
    cached = { at: nowMs, result };
    return result;
  }

  // The probe ATTEMPTS A REAL WRITE rather than inspecting permission bits,
  // because permission bits lie. A mode that says writable still fails on a
  // full disk (ENOSPC), a read-only mount (EROFS), a Windows ACL that the
  // POSIX-shaped mode never described, or a path that turned out to be a
  // directory. The only honest question is "did a write succeed", so that
  // is the question asked.
  function probe() {
    let file;
    try {
      // Resolving the path also creates var/logs. That can throw on its own
      // (a parent that is a file, a root that cannot be created), and that
      // is a genuine unwritable condition, so it belongs inside the try.
      file = paths.logPath(AUDIT_FILE);
    } catch (err) {
      return { ok: false, reason: `log path unavailable: ${err.code || err.message}` };
    }

    // Two probes, because they fail independently. The directory probe
    // catches the case where rotation would fail (renaming and creating
    // archives needs the DIRECTORY writable) while the file itself happens
    // to be appendable; the append probe catches an ACL or a lock on the
    // log file itself while the directory is fine.
    const probeFile = join(paths.logsDir, `.audit-probe-${process.pid}`);
    try {
      writeFileSync(probeFile, "probe", "utf8");
    } catch (err) {
      return { ok: false, reason: `log directory not writable: ${err.code || err.message}` };
    }
    try {
      unlinkSync(probeFile);
    } catch {
      // A probe file we could create but not remove is untidy, never unsafe:
      // appending to the real log is unaffected. Swallowed so a stale probe
      // cannot become the reason the server refuses to act.
    }

    // IMPORTANT: a path that exists but is NOT a regular file is unwritable
    // no matter what open() says about it. On Windows `openSync(dir, "a")`
    // SUCCEEDS against a directory and only the first real byte fails with
    // EISDIR, so an open-only probe would report a healthy log right up
    // until the moment the first record was dropped. Checked explicitly.
    try {
      if (!statSync(file).isFile()) {
        return { ok: false, reason: "audit path exists but is not a regular file" };
      }
    } catch {
      // Not there yet is not a failure: the append below creates it.
    }

    let fd;
    try {
      // Append mode, so an existing log is never truncated by the check
      // that is supposed to protect it. Rejected the stronger alternative
      // of appending a real byte to the audit log itself: it would prove
      // more, but it writes a non-record line into a file downstream JSONL
      // parsers read strictly, and it grows the log every few seconds for
      // the life of the process. The real-byte write happens on the probe
      // file above instead, in the same directory and on the same mount.
      fd = openSync(file, "a");
    } catch (err) {
      return { ok: false, reason: `audit file not writable: ${err.code || err.message}` };
    }
    try {
      closeSync(fd);
    } catch {
      // Same reasoning as the probe unlink: a leaked descriptor is a
      // resource nuisance, not a reason to declare the log unwritable.
    }
    return { ok: true, reason: "" };
  }

  /**
   * Refuse to proceed unless the audit log is writable. Call before the effect.
   */
  function refuseIfUnauditable() {
    const { ok, reason } = auditWritable();
    // FAIL CLOSED: the throw is the feature. Returning a result object here
    // would let a caller ignore it and perform an unaccountable write, which
    // is precisely the outcome this module exists to make impossible.
    if (!ok) throw new AuditUnavailableError(reason);
  }

  // Shift archives up one slot and move the live log to ".1" when the
  // incoming record would push the file past the size cap.
  //
  // Rotation happens BEFORE the append, never after, so the record being
  // written lands in a file that has room for it and is never the record
  // that gets renamed out from under a half-finished write.
  function rotateIfNeeded(file, incomingBytes) {
    if (keep < 1) return;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // No log yet, or it vanished: nothing to rotate, and the append that
      // follows will create it.
      return;
    }
    if (size + incomingBytes <= maxBytes) return;
    try {
      // Drop the oldest generation first, then walk DOWNWARD so each rename
      // moves into a slot that was just vacated. Walking upward would
      // overwrite ".2" with ".1" before ".2" had been moved to ".3".
      try {
        unlinkSync(`${file}.${keep}`);
      } catch {
        // Not present yet on the first few rotations; nothing to drop.
      }
      for (let i = keep - 1; i >= 1; i--) {
        try {
          renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        } catch {
          // A generation that does not exist yet. Skipping it is correct:
          // the slots fill in as the log ages.
        }
      }
      renameSync(file, `${file}.1`);
    } catch (err) {
      // FAIL OPEN here, and ONLY here. Everywhere else this module prefers
      // refusing to act, but rotation is housekeeping: if it fails we fall
      // through and append to the current file anyway. An oversized audit
      // log is an operations problem; a DROPPED audit record is the exact
      // permanent loss this module exists to prevent.
      console.error(`[audit] rotation failed, appending anyway: ${err.code || err.message}`);
    }
  }

  // Serialize and append ONE record. Returns `{ ok, reason }` rather than
  // throwing, because the two call sites want opposite handling and that
  // decision belongs to them, not here.
  function append(record) {
    let file;
    try {
      file = paths.logPath(AUDIT_FILE);
    } catch (err) {
      return { ok: false, reason: `log path unavailable: ${err.code || err.message}` };
    }
    const line = `${JSON.stringify(record)}\n`;
    rotateIfNeeded(file, Buffer.byteLength(line, "utf8"));
    try {
      // Append-only, one JSON object per line. JSONL and NOT a single JSON
      // array, because an array has to be parsed and rewritten whole: a
      // crash mid-rewrite corrupts every historical record at once, and an
      // append-only file is the only shape a tail-based collector can read
      // while the server is still writing to it.
      appendFileSync(file, line, "utf8");
    } catch (err) {
      return { ok: false, reason: `append failed: ${err.code || err.message}` };
    }
    return { ok: true, reason: "" };
  }

  //
  // ===================================================================
  // THE CORRECTION. Read this before moving either call.
  // ===================================================================
  // The production system this pattern comes from wrote its audit record
  // AFTER the write that record described. That ordering is backwards, and
  // the failure is permanent rather than transient: a throw between the
  // effect and the log loses the record entirely, and because that code
  // path is idempotency-marked it is never retried and never backfilled.
  // The effect is real and there is no evidence it ever happened. The
  // invariant, "no unaccountable write", ran in reverse: the write was
  // guaranteed and the accountability was best-effort.
  //
  // This is a subtle and natural mistake, which is WHY it is called out
  // this loudly. You want to log the RESULT, and you cannot know the
  // result until the action has run, so the logging call drifts naturally
  // to after the action. The pull is real; the conclusion is wrong.
  //
  // PATTERN: TWO records, not one. An `intent` written before the effect
  // and an `outcome` written after, correlated by id. The intent costs one
  // extra line and buys the thing that actually matters:
  //
  //   IMPORTANT: an intent with no outcome is exactly the signal you want
  //   during an incident. It says "the server was about to do X to Y and
  //   we do not know whether it completed", which is a question an
  //   operator can go and answer. A missing single record says nothing at
  //   all, and silence is indistinguishable from "it never happened".
  //
  // A dangling intent is therefore NOT a bug in this log. It is the
  // product. Do not "fix" it by deferring the intent write until the
  // outcome is known: that collapses the two records back into the one
  // record that fails exactly the way described above.
  // ===================================================================

  /**
   * Record the INTENT to act and return a correlation id. Call BEFORE the effect.
   */
  function auditIntent({ action, resourceId, payload, meta } = {}) {
    // The gate lives INSIDE the intent write, not merely next to it in a
    // caller's happy path. An optional gate is a gate that eventually gets
    // skipped by the one call site written in a hurry, and that call site
    // is the unaccountable write. Throws AuditUnavailableError.
    refuseIfUnauditable();
    const id = newId();
    const result = append({
      ts: now().toISOString(),
      id,
      phase: "intent",
      action: String(action ?? "unknown"),
      resourceId: String(resourceId ?? ""),
      // The hash, never the payload. See `hashPayload`.
      payloadSha256: hashPayload(payload),
      meta: safeMeta(meta),
    });
    // The probe said writable and the append still failed, so the state of
    // the world changed between the two. Refuse: we are back to "cannot
    // account for it", and the caller has not acted yet, so refusing here
    // is still free.
    if (!result.ok) throw new AuditUnavailableError(result.reason);
    return id;
  }

  /**
   * Record the OUTCOME of an already-attempted action. Call AFTER the effect.
   */
  function auditOutcome(id, { status, detail, meta } = {}) {
    // NOTE: this deliberately does NOT throw and does NOT re-gate on
    // writability. The effect has already happened by the time this runs.
    // Throwing here would report a LOGGING failure to the caller as if the
    // action itself had failed, and a caller that then rolls back or
    // retries a completed write does real damage. The honest outcome is a
    // result object plus a dangling intent in the log, which is the
    // incident signal described above.
    return append({
      ts: now().toISOString(),
      id: String(id ?? ""),
      phase: "outcome",
      status: String(status ?? "unknown"),
      // Free text from a caller, so it goes through the same redaction as a
      // payload. An error body pasted in here is the most likely way a
      // bearer token reaches this file.
      detail: detail === undefined ? "" : redact(detail),
      meta: safeMeta(meta),
    });
  }

  // Metadata is written in the clear (that is its purpose: something an
  // operator can read without a lookup), so it is restricted to scalars and
  // still run through redaction. Rejected the alternative of passing an
  // arbitrary object through untouched: "safe metadata" enforced only by a
  // comment is a matter of time, and nested objects are how a whole request
  // body ends up in the log under a friendly key name.
  function safeMeta(meta) {
    if (meta === null || meta === undefined) return {};
    if (typeof meta !== "object" || Array.isArray(meta)) return {};
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
      if (typeof value === "string") out[key] = redact(value);
      else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
      // Anything else (object, array, function, symbol) is dropped rather
      // than stringified, so there is no path by which a nested payload
      // becomes a log line.
    }
    return out;
  }

  return {
    auditPath: () => paths.logPath(AUDIT_FILE),
    auditWritable,
    refuseIfUnauditable,
    auditIntent,
    auditOutcome,
  };
}

// Bound default instance for normal callers, matching the tail of
// paths.mjs. Construction does no I/O, so importing this module is safe
// even on a host where var/ cannot be created; the failure surfaces at the
// first `auditWritable()` as a refusal, which is where it can be reported.
// Rotation is taken from CONFIG rather than the module constants above, so
// the env vars declared in .env.example actually decide something. The
// constants remain the fallback for a caller building its own instance with
// createAuditLog(root) and no overrides, which is what the tests do.
const defaults = createAuditLog(ROOT, {
  maxBytes: CONFIG.AUDIT_MAX_BYTES,
  keep: CONFIG.AUDIT_KEEP_FILES
});
export const auditPath = defaults.auditPath;
export const auditWritable = defaults.auditWritable;
export const refuseIfUnauditable = defaults.refuseIfUnauditable;
export const auditIntent = defaults.auditIntent;
export const auditOutcome = defaults.auditOutcome;
