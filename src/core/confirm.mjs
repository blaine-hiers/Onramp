/**
 * =========================================================================
 * TWO-PHASE CONFIRMATION TOKENS
 * =========================================================================
 * Server-minted, single-use approval for an irreversible tool action.
 *
 * The obvious design is a `confirm: true` boolean on the tool's input
 * schema, and it is broken. The confirm flag is supplied by the model, and
 * the model is the thing being gated. A model that has ingested untrusted
 * content in the same session (a web page, an email body, a ticket
 * comment) will set `confirm: true` as readily as it sets any other
 * argument. It is not a confirmation, it is a parameter with a reassuring
 * name.
 *
 * So the approval is minted HERE, by the server, and handed back as an
 * opaque token bound to a hash of the exact payload. Phase one previews
 * and mints; phase two spends. The caller cannot forge a token (256 bits
 * of entropy), cannot spend one twice (single use), cannot sit on one
 * forever (TTL), and cannot spend an approval granted for a harmless
 * payload on a different one (the payload hash is part of the record).
 *
 * HONEST LIMITATION: this gates WHAT is sent, NOT who decided to send it.
 * The model still chooses when to spend a token it is holding, and a token
 * minted during a poisoned turn can be spent in that same turn. What the
 * token actually buys is that the bytes someone approved are the bytes
 * that ship, and that a swapped payload is rejected instead of quietly
 * sent. Closing the remaining gap needs an out-of-band human approval
 * channel (a second device, a chat prompt, a signed click), which a stdio
 * server has no way to reach. The gap is named here rather than papered
 * over: do NOT describe this module as human-in-the-loop approval.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { statePath } from "./paths.mjs";

// Lives in the var/state/ tree with every other runtime file, resolved
// through paths.mjs so the repo root stays code plus config only.
const STATE_FILE = "confirm-tokens.json";

// Stamped into the file so a later format change can be detected instead
// of being silently mis-parsed as the current shape.
const STORE_VERSION = 1;

// Long enough for a human to read a preview and decide, short enough that
// an approval cannot be banked and spent an hour later against a payload
// nobody is looking at any more.
const DEFAULT_TTL_MS = 15 * 60 * 1000;

// A ceiling on what a caller may request. An approval that outlives the
// conversation it came from is not a confirmation, it is a standing
// permission, which is the exact thing this module exists to prevent.
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

// 32 bytes is 256 bits of entropy, which is not guessable by any means
// this threat model has to worry about.
const TOKEN_BYTES = 32;

/**
 * The reason codes a caller branches on. Plain strings on a result object
 * rather than error subclasses, because nothing here throws across the
 * module boundary:
 *
 *   ""                  valid (ok: true)
 *   "malformed_token"   not a non-empty string, so it was never minted here
 *   "not_found"         no record: never minted, or already swept
 *   "expired"           minted here, but the TTL has run out
 *   "already_consumed"  single-use token presented a second time
 *   "resource_mismatch" the approval was for a different resource
 *   "payload_mismatch"  the payload changed between mint and spend
 *   "storage_error"     the consumption could not be recorded, so it did
 *                       not happen (FAIL CLOSED)
 */

// A fresh object per call, NOT one shared frozen literal: a caller that
// decorates the result (attaching a message, say) would otherwise mutate
// the object every later call returns.
function ok() {
  return { ok: true, reason: "" };
}

function fail(reason) {
  return { ok: false, reason };
}

// Deterministic serialization for the hash. JSON.stringify follows key
// INSERTION order, so a payload that round-tripped through JSON.parse on
// its way back from the client can serialize its keys in a different order
// than it did at mint time and hash to a different digest. That rejects a
// legitimate confirmation, and a gate that rejects honest work teaches
// operators to route around it. Sorting keys removes the false rejection
// without weakening the true one.
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    // JSON.stringify returns undefined for undefined, functions and
    // symbols. Fold those to a literal so the digest input is always a
    // string, rather than the characters "undefined" turning up by
    // accident inside a larger serialization.
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// IMPORTANT: this hashes the RAW payload, never a redacted or truncated
// preview of it. Redaction is lossy by design: two materially different
// payloads whose secrets both collapse to "[REDACTED]" hash to the same
// value, so an approval granted for one would authorize the other. The
// preview shown to a human may be redacted; the bytes bound to the token
// may not be.
function hashPayload(payload) {
  const bytes = Buffer.isBuffer(payload)
    ? payload
    : ArrayBuffer.isView(payload)
      ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
      : typeof payload === "string"
        ? Buffer.from(payload, "utf8")
        : Buffer.from(stableStringify(payload), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

// The token is a bearer credential, so what lands on disk is its digest and
// never the token itself.
//
// WHY: anyone who can read var/state/confirm-tokens.json could otherwise lift
// a pending approval and spend it. Storing only the digest means a reader of
// the file learns that an approval exists and what it is bound to, but cannot
// present it. The server does not need the original back, it only ever has to
// answer "is the token I was just handed the one that was minted", and a hash
// comparison answers that.
//
// This is the same reasoning that says never store a password. An approval to
// perform an irreversible action deserves the same treatment.
function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

// WHY random and NOT a sequential id: the token IS the security property.
// With a counter, a caller that never previewed anything can simply
// present "token-7" and spend an approval it was never shown. The token
// has to be something only this server could have produced, which means
// unguessable. base64url keeps it safe to drop into a JSON string, a URL
// or a log line without escaping.
function newToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

// A non-finite ttl is the dangerous input here, not a large one: NaN
// propagates into expiresAt, and every later `expiresAt > now` comparison
// against NaN is false, so the record reads as expired and the mint is
// silently useless. Garbage therefore falls back to the conservative
// default, and an over-long request is clamped rather than honored.
function normalizeTtl(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return DEFAULT_TTL_MS;
  return Math.min(ttlMs, MAX_TTL_MS);
}

/**
 * Build a confirmation store over one state file, with the clock and the
 * rename injected so tests can drive both.
 */
export function createConfirmStore(file, { now = Date.now, rename = renameSync, generateToken = newToken } = {}) {
  // Resolved on first use, NOT at construction: statePath() creates
  // var/state/ as a side effect, and the default instance at the bottom of
  // this file is built at module load. Doing it eagerly would mean merely
  // importing this module (in a test, a lint pass, a syntax check) creates
  // directories in the repo. paths.mjs is lazy for the same reason.
  function resolveFile() {
    return file || statePath(STATE_FILE);
  }

  // FAIL CLOSED: an unreadable or corrupt store yields an empty record set,
  // so every outstanding token stops validating and has to be re-minted.
  // That is the safe direction. The opposite failure mode, treating an
  // unparseable file as "no reason to object", would turn a truncated write
  // into an approval bypass.
  function readRecords() {
    const target = resolveFile();
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8"));
      const records = Array.isArray(parsed?.records) ? parsed.records : [];
      // Anything that lost its digest can never be looked up again, so
      // keeping it would only grow the file forever.
      return records.filter((r) => r && typeof r.tokenSha256 === "string");
    } catch (err) {
      // ENOENT is the ordinary first-run case and does not deserve a line
      // on stderr. Anything else means the file exists and did not parse,
      // which an operator needs to see, because it just invalidated every
      // pending confirmation.
      if (err.code !== "ENOENT") {
        console.error(`[confirm] unreadable token store ${target}: ${err.code || err.message}`);
      }
      return [];
    }
  }

  // PATTERN: write a temp file, then rename over the target. renameSync is
  // atomic within a filesystem, so a crash leaves either the whole old file
  // or the whole new one. Truncating the real file in place is the failure
  // this avoids: a crash between the truncate and the last byte leaves
  // invalid JSON on disk, and the next boot then loses every pending token
  // at once.
  // Rename, retrying briefly on a transient Windows EPERM.
  //
  // WHY this exists: renameSync over an EXISTING file is atomic on POSIX and
  // is the whole reason this module writes temp-then-rename. On Windows it
  // can also fail with EPERM when something else holds a transient handle on
  // the destination, which on a developer machine means the search indexer,
  // a backup agent, or antivirus walking the tree. Measured at roughly one
  // failure in fifty full test-suite runs with this repo under Documents.
  //
  // Failing closed there is CORRECT and stays correct: a caller gets "" back
  // and no approval is issued. But a confirmation that refuses at random,
  // for a reason the operator cannot see and did not cause, is the kind of
  // flakiness that gets a safety feature switched off. A few short retries
  // cost nothing and remove the whole class of spurious refusal.
  //
  // Bounded on purpose: this retries a LOCK, not a fault. EPERM that is
  // really a permissions problem fails the same way a moment later, and
  // every other error code is rethrown immediately rather than waited on.
  function renameWithRetry(from, to) {
    const attempts = 5;
    for (let i = 0; i < attempts; i++) {
      try {
        rename(from, to);
        return;
      } catch (err) {
        const transient = err.code === "EPERM" || err.code === "EACCES" || err.code === "EBUSY";
        if (!transient || i === attempts - 1) throw err;
        // Busy-wait rather than await: save() is synchronous and every caller
        // depends on that. The total worst case here is a few milliseconds.
        const until = Date.now() + 2 * (i + 1);
        while (Date.now() < until) {
          // Intentionally empty: a sub-millisecond spin, not a sleep.
        }
      }
    }
  }

  function save(records) {
    const target = resolveFile();
    // The pid keeps two processes from writing the same scratch file and
    // interleaving their bytes into one corrupt temp.
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, records }, null, 2), "utf8");
      renameWithRetry(tmp, target);
      return true;
    } catch (err) {
      console.error(`[confirm] could not persist ${target}: ${err.code || err.message}`);
      // Best effort cleanup so a failed write does not leave scratch files
      // piling up beside the store. Failing to remove it is not worth a
      // second line on stderr.
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing useful to do: the write already failed and was reported.
      }
      return false;
    }
  }

  // Sweep on load: every read partitions the file into records that are
  // still live and tokens that have aged out, so nothing expired can reach
  // a decision. The swept set is written back by the next call that writes
  // anyway (mint or consume) rather than by the read itself, because
  // validate MUST NOT touch storage. Holding the expired tokens in a lookup
  // set for the duration of the call is what lets validate answer "expired"
  // instead of the far less useful "not_found": that is the difference
  // between an operator minting a fresh token and an operator hunting for a
  // payload bug that does not exist.
  function load() {
    const nowMs = now();
    const live = [];
    const expired = new Set();
    for (const r of readRecords()) {
      // A record with a missing or non-numeric expiry counts as expired,
      // NOT as never-expiring. Corruption must not manufacture an immortal
      // approval.
      if (Number.isFinite(r.expiresAt) && r.expiresAt > nowMs) live.push(r);
      else expired.add(r.tokenSha256);
    }
    return { nowMs, live, expired };
  }

  // The whole decision, shared by validate and consume so the two cannot
  // drift apart. A consume that accepted something validate rejects (or the
  // reverse) would make the preview step meaningless.
  function check(token, { resourceId, payload } = {}, state) {
    if (typeof token !== "string" || token.length === 0) {
      return fail("malformed_token");
    }
    // Hash once, then compare digests. The stored side never held the token,
    // so this is the only comparison that can work.
    const digest = hashToken(token);
    const record = state.live.find((r) => r.tokenSha256 === digest);
    if (!record) {
      return fail(state.expired.has(digest) ? "expired" : "not_found");
    }
    // Checked before the binding comparisons on purpose: if the token was
    // already spent, that is the fact the caller needs, and reporting a
    // payload mismatch instead would send them looking in the wrong place.
    if (record.consumedAt != null) {
      return fail("already_consumed");
    }
    // Bound to the resource as well as the payload, so an approval for
    // "delete draft 4" cannot be redirected at "delete draft 900" even when
    // the two payloads serialize identically.
    if (record.resourceId !== String(resourceId ?? "")) {
      return fail("resource_mismatch");
    }
    // The equality that carries the whole feature: approval was granted for
    // these exact bytes, so any edit between preview and send lands here as
    // a rejection instead of shipping unreviewed content.
    if (record.payloadSha256 !== hashPayload(payload)) {
      return fail("payload_mismatch");
    }
    return ok();
  }

  /** Mint a token bound to this resource and payload. "" means failure. */
  function mintConfirmToken({ resourceId, payload, ttlMs } = {}) {
    const { nowMs, live } = load();
    const token = generateToken();
    const record = {
      // The digest, NOT the token. The caller is handed the only copy of the
      // token that will ever exist; nothing on disk can reconstruct it.
      tokenSha256: hashToken(token),
      resourceId: String(resourceId ?? ""),
      payloadSha256: hashPayload(payload),
      expiresAt: nowMs + normalizeTtl(ttlMs),
      consumedAt: null
    };
    // FAIL CLOSED: handing back a token whose record never reached disk
    // would produce an approval that looks valid and then mysteriously
    // fails at spend time. An empty string can never validate, so the
    // caller finds out now, before showing anyone a preview.
    if (!save([...live, record])) return "";
    return token;
  }

  /** Check a token WITHOUT spending it. Never throws, never writes. */
  function validateConfirmToken(token, expected = {}) {
    // The natural operator workflow is preview, decide, then send. If the
    // preview burned the token, people would learn to skip previewing,
    // which defeats the point of a two-phase gate entirely. So the
    // read-only path is a first-class function, NOT a flag on consume.
    return check(token, expected, load());
  }

  /** Validate a token and mark it consumed in the same pass. Never throws. */
  function consumeConfirmToken(token, expected = {}) {
    const state = load();
    const verdict = check(token, expected, state);
    if (!verdict.ok) return verdict;
    // Read, decide and write all happen inside this one synchronous call,
    // and the write lands through an atomic rename, so nothing in THIS
    // process can interleave and spend the token twice.
    //
    // NOTE the residual: two separate processes sharing the file could both
    // read before either writes, and the later write would win. A stdio MCP
    // server is one process per client, so that race is out of scope here.
    // The rejected alternative was a lockfile, which trades a race nobody
    // hits for a stale-lock outage that wedges every confirmation after a
    // hard kill.
    const digest = hashToken(token);
    const next = state.live.map((r) =>
      r.tokenSha256 === digest ? { ...r, consumedAt: state.nowMs } : r
    );
    // FAIL CLOSED: if the consumption cannot be recorded, report failure.
    // Returning ok here would let an irreversible action run against a
    // token that is still sitting on disk unspent.
    if (!save(next)) return fail("storage_error");
    return ok();
  }

  return { mintConfirmToken, validateConfirmToken, consumeConfirmToken };
}

// The instance tools use. Its file path resolves on first call, so
// importing this module still performs no I/O.
const defaults = createConfirmStore();

export const mintConfirmToken = defaults.mintConfirmToken;
export const validateConfirmToken = defaults.validateConfirmToken;
export const consumeConfirmToken = defaults.consumeConfirmToken;
