/**
 * =========================================================================
 * TYPED CONFIGURATION (the ONE reader of process.env)
 * =========================================================================
 * Every other module imports CONFIG from here and never touches
 * process.env itself. WHY: env values are stringly typed and arrive from
 * three unrelated places (a shell, an MCP client's launch config, a
 * container), so scattering `process.env.X === "true"` across the codebase
 * means every gate re-invents its own coercion and sooner or later one of
 * them gets it backwards. One reader, one coercion, one snapshot.
 *
 * FAIL CLOSED is the rule for every helper below: a value this module
 * cannot parse falls back to the in-code default, and the defaults are
 * chosen to be the SAFE setting (DRY_RUN starts TRUE), so a typo in a
 * launch config can never widen a gate that was closed.
 *
 * The snapshot is taken once, at import, and frozen. Mutating process.env
 * afterwards does NOT change CONFIG: a process that is half reconfigured
 * mid-flight is harder to reason about than one that needs a restart.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";

import { ROOT } from "./paths.mjs";

/* =========================================================================
 * .ENV LOADING
 * ========================================================================= */

// This module loads .env itself rather than trusting server.mjs to have
// done it first. WHY: ESM hoists imports, so every imported module's body
// runs BEFORE the importing file's first statement. A server.mjs that
// calls dotenv at the top of its own body would still be running that
// call AFTER this file had snapshotted process.env, and every value here
// would silently be the default while a fully populated .env sat on disk.
// Owning the load is the only ordering that cannot break.
//
// MCP_ENV_FILE points the loader at a different file: a container or a
// standalone worker may not share the repo root, and the test suite aims
// it at a path that does not exist so the suite stays hermetic.
const ENV_FILE = process.env.MCP_ENV_FILE?.trim() || join(ROOT, ".env");
if (existsSync(ENV_FILE)) {
  // quiet: true because dotenv v17 prints a banner to STDOUT, which is
  // the MCP JSON-RPC channel. A banner there corrupts the stream and the
  // client drops the connection with no useful error.
  // dotenv does not override an already-set variable, so a value handed
  // in by the MCP client's launch config still wins over the file.
  loadDotenv({ path: ENV_FILE, quiet: true });
}

/* =========================================================================
 * TYPED COERCION HELPERS
 * ========================================================================= */

// Words accepted as booleans. Deliberately a closed set: anything else is
// unparseable and takes the default, so "flase" cannot read as false.
const TRUE_WORDS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n", "off"]);

// Integers are matched by shape, NOT by Number(). Number("0x10") is 16 and
// Number("1e3") is 1000, so a typo in a launch config would quietly become
// a plausible looking number instead of falling back to a vetted default.
const INT_PATTERN = /^[+-]?\d+$/;

/**
 * Coerce a config value to a real boolean, failing closed to `dflt`.
 *
 * IMPORTANT: a blank string ("") is treated as UNSET, not as false. This
 * is the one place this module deliberately disagrees with `asBool` in
 * src/core/util.mjs, which maps "" to false. The two coerce different
 * things. util's helper coerces a TOOL ARGUMENT from a model, where an
 * empty string is a plausible "nothing here" and false is the harmless
 * reading. This one coerces OPERATOR CONFIG, where `MCP_DRY_RUN=` in a
 * .env file is a half-finished edit. Reading that as false would turn the
 * dry-run gate OFF and let a fresh clone touch the outside world, which
 * is the exact failure the default exists to prevent.
 */
export function asBool(v, dflt = false) {
  if (typeof v === "boolean") return v;
  // A NaN or an Infinity here is a broken caller, not an intent to flip a
  // flag, so it takes the default rather than the truthiness of NaN.
  if (typeof v === "number") return Number.isFinite(v) ? v !== 0 : dflt;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "") return dflt;
    if (TRUE_WORDS.has(s)) return true;
    if (FALSE_WORDS.has(s)) return false;
  }
  return dflt;
}

/**
 * Coerce a config value to a safe integer, failing closed to `dflt` and
 * clamping anything parseable into [min, max].
 *
 * Out of range CLAMPS, unparseable FALLS BACK. The two differ on purpose:
 * "3000000" for a TTL is a legible intent that happens to sit past the
 * ceiling, and pinning it to the ceiling keeps the operator's direction
 * while the ceiling keeps the safety. "3 minutes" is not an intent this
 * module can read at all, and guessing at it is how a gate ends up wider
 * than anyone asked for.
 */
export function asInt(v, dflt, { min = -Infinity, max = Infinity } = {}) {
  const clamp = (n) => Math.min(max, Math.max(min, n));
  if (typeof v === "number") return Number.isInteger(v) ? clamp(v) : dflt;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || !INT_PATTERN.test(s)) return dflt;
    const n = Number(s);
    // Past 2^53, arithmetic on the value stops being exact, so a "number"
    // that large is treated as unreadable rather than as a real bound.
    if (!Number.isSafeInteger(n)) return dflt;
    return clamp(n);
  }
  return dflt;
}

/**
 * Coerce a comma separated config value to a de-duplicated array of
 * trimmed, non-empty strings, failing closed to `dflt`.
 *
 * NOTE: a blank string yields the DEFAULT list, not an empty list. There
 * is deliberately no way to spell "empty" in an env var here, because
 * every list this module builds is a safety list (see `widen` below) and
 * a stray `MCP_..._EXTRA=` in a .env must not be able to empty one.
 *
 * Case is preserved. Callers that compare case-insensitively normalize at
 * their own site, so this helper stays usable for values (a path, a
 * display name) where case is load-bearing.
 */
export function asList(v, dflt = []) {
  if (Array.isArray(v)) return normalizeList(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return normalizeList(dflt);
    return normalizeList(s.split(","));
  }
  return normalizeList(dflt);
}

// Shared tail of asList: trim, drop empties (so "a,,b" and a trailing
// comma are both harmless), and drop exact duplicates while keeping the
// first occurrence so the order stays predictable in a log line.
function normalizeList(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const s = String(item).trim();
    if (s === "" || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return Object.freeze(out);
}

/**
 * Coerce a config value to a member of a CLOSED set, failing closed to
 * `dflt`.
 *
 * FAIL CLOSED: an unreadable value returns `dflt` and never a wildcard.
 * There is no special handling of "*", "any" or "all". If one of those is
 * a legitimate setting it belongs IN the closed set, spelled out, so that
 * granting it is a visible edit to this file rather than a side effect of
 * a misspelling in someone's shell.
 *
 * NOTE: a `dflt` that is not itself a member of `allowed` is returned
 * anyway. That is a bug in this file, and returning it unmodified makes
 * it show up in the first log line instead of being masked.
 */
export function asEnum(v, allowed, dflt) {
  const members = Array.isArray(allowed) ? allowed : Array.from(allowed);
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s !== "" && members.includes(s)) return s;
  }
  return dflt;
}

/**
 * Extend an in-code default set with an operator supplied one.
 *
 * WIDEN ONLY, which is the whole reason the function exists. Every set
 * built with it is one where MORE entries means MORE safety (more keys
 * redacted, more tools forced through a confirmation), so an env var may
 * add and may never remove. There is no replace form and no removal
 * syntax such as a leading "-": a launch config that could shrink the
 * redaction list is a launch config that can make the audit log start
 * printing bearer tokens, and no convenience is worth that.
 *
 * Entries are lowercased because every consumer of these sets compares
 * case-insensitively, and "Authorization" arriving in two casings would
 * otherwise defeat the de-duplication.
 */
export function widen(defaults, extra) {
  const out = [];
  const seen = new Set();
  for (const item of [...defaults, ...asList(extra, [])]) {
    const key = String(item).trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return Object.freeze(out);
}

/* =========================================================================
 * THE SNAPSHOT
 * ========================================================================= */

// Names of variables that are SET but empty. A blank is a distinct third
// state from "unset" and "has a value": it almost always means a
// half-finished edit, and since every helper above resolves it to the
// default, nothing else would ever surface it. Recording the names lets
// the server say so once at startup instead of leaving an operator to
// wonder why their setting did nothing.
const BLANK_NAMES = [];

// The ONE place process.env is indexed for a config value. Every read
// goes through here so the blank check cannot be forgotten on a variable
// added later.
function readEnv(name) {
  const raw = process.env[name];
  if (typeof raw === "string" && raw.trim() === "") BLANK_NAMES.push(name);
  return raw;
}

// Keys always stripped from an audit record or an error body. Widen only:
// see `widen` above for why nothing can shorten this list.
const DEFAULT_REDACT_KEYS = [
  "authorization",
  "api_key",
  "apikey",
  "token",
  "access_token",
  "refresh_token",
  "password",
  "secret",
  "cookie",
  "set-cookie"
];

// Tool name prefixes that must clear a human confirmation before running.
// Widen only for the same reason: adding a prefix can only ever make the
// server ask more often, never less.
const DEFAULT_CONFIRM_REQUIRED = ["delete_", "send_", "post_", "update_"];

// Ceilings for the ranged values. They exist so that a fat-fingered extra
// zero cannot hold a confirmation token valid for a week, or let the
// audit log grow until it fills the disk the server runs on.
const CONFIRM_TTL_DEFAULT_MS = 15 * 60 * 1000;
const CONFIRM_TTL_MAX_MS = 60 * 60 * 1000;
const AUDIT_MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const AUDIT_MAX_BYTES_CEILING = 512 * 1024 * 1024;

/**
 * The frozen, coerced configuration for this process.
 *
 * Object.freeze is shallow, so each list value is frozen by the helper
 * that built it. Without that, a caller doing
 * CONFIG.AUDIT_REDACT_KEYS.pop() would mutate shared state and quietly
 * stop redacting a key for every other module in the process.
 */
export const CONFIG = Object.freeze({
  // Shown in the MCP registration and prefixed on every stderr log line.
  SERVER_NAME: readEnv("MCP_SERVER_NAME")?.trim() || "<SERVER_NAME>",

  // Which category of tools this process exposes. NOT an asEnum: the set
  // of valid values is declared by the tool files themselves, so a closed
  // list here would go stale every time a tool is added. An unrecognized
  // value is still fail closed, because registry.mjs matches it against
  // no category and the process then exposes zero tools rather than all
  // of them. Lowercased and trimmed because on Windows `set MCP_TOOLSET=x
  // && node ...` bakes a trailing space into the value.
  TOOLSET: String(readEnv("MCP_TOOLSET") ?? "").trim().toLowerCase() || "all",

  // DEFAULTS TO TRUE, deliberately. A freshly cloned server, run before
  // anyone has read the docs, must not be able to send a message, delete
  // a record, or otherwise reach the outside world. Turning it off is an
  // explicit act by someone who has decided the integration is wired up.
  DRY_RUN: asBool(readEnv("MCP_DRY_RUN"), true),

  // How long a confirmation token stays valid. Short by default, because
  // the token exists to prove a human agreed to THIS action a moment ago,
  // and a long window quietly turns it into a standing permission.
  CONFIRM_TTL_MS: asInt(readEnv("MCP_CONFIRM_TTL_MS"), CONFIRM_TTL_DEFAULT_MS, {
    min: 1000,
    max: CONFIRM_TTL_MAX_MS
  }),

  // Rotation thresholds for the audit log. The floor on the size keeps
  // rotation from thrashing once per write; the floor of 1 on the file
  // count keeps at least the current log on disk.
  AUDIT_MAX_BYTES: asInt(readEnv("MCP_AUDIT_MAX_BYTES"), AUDIT_MAX_BYTES_DEFAULT, {
    min: 64 * 1024,
    max: AUDIT_MAX_BYTES_CEILING
  }),
  AUDIT_KEEP_FILES: asInt(readEnv("MCP_AUDIT_KEEP_FILES"), 5, { min: 1, max: 100 }),


  // Both of these are widen only. The env var appends to the in-code
  // list; nothing anywhere can shorten or replace it.
  AUDIT_REDACT_KEYS: widen(DEFAULT_REDACT_KEYS, readEnv("MCP_AUDIT_REDACT_EXTRA")),
  CONFIRM_REQUIRED_TOOLS: widen(
    DEFAULT_CONFIRM_REQUIRED,
    readEnv("MCP_CONFIRM_REQUIRED_EXTRA")
  ),

  // Set but empty, as described at BLANK_NAMES. A frozen copy, so a
  // reader cannot push into the array this module still holds.
  BLANK_ENV_VARS: Object.freeze([...BLANK_NAMES])
});

// One line, once, on STDERR (stdout is the MCP JSON-RPC channel and any
// non-protocol byte there corrupts the stream). Written at import so the
// operator sees it in the client's server log next to the startup line,
// rather than never, which is what happens when a blank silently resolves
// to a default.
if (CONFIG.BLANK_ENV_VARS.length > 0) {
  console.error(
    `[${CONFIG.SERVER_NAME}] config: set but empty, using defaults: ` +
      CONFIG.BLANK_ENV_VARS.join(", ")
  );
}
