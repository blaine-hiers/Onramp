/**
 * =========================================================================
 * ENV SYNC - render .env from Doppler (scripts/env-sync.mjs)
 * =========================================================================
 * Doppler is the source of truth; the on-disk .env is a GENERATED artifact.
 * This script downloads the active Doppler config in env format, validates
 * it, backs up the current .env to .env.bak, and atomically replaces .env.
 * With --diff it only reports key-NAME differences (never values) and
 * writes nothing.
 *
 * FAIL CLOSED: any failure (Doppler unreachable, empty/suspect payload)
 * leaves the existing .env exactly as it was and exits non-zero. A Doppler
 * outage means "can't change env right now", never "the server dies".
 *
 * Set DOPPLER_PROJECT (below, or via the Doppler CLI's own directory scope)
 * to your project before running this for real; `<SERVER_NAME>` in .env.example
 * documents the var this script expects every payload to carry.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

const log = (...a) => console.error("[env-sync]", ...a);

// A var every working .env for this server should carry. Its absence means
// the download is not this project's config (wrong scope, error page,
// truncation) - refuse rather than install it. Replace with a var your own
// server always sets once you're past the template stage.
const SENTINEL = "MCP_SERVER_NAME=";

/** Is this downloaded payload plausibly our .env? */
export function validateEnvPayload(text) {
  const t = String(text ?? "");
  if (!t.trim()) return { ok: false, reason: "payload is empty" };
  if (!t.includes(SENTINEL)) {
    return { ok: false, reason: `payload lacks sentinel ${SENTINEL} - wrong config or truncated download` };
  }
  return { ok: true, reason: "" };
}

/** Header + payload. Header lines are all comments so dotenv skips them. */
export function renderEnvFile(payload, { config = "(unknown)", now = new Date() } = {}) {
  const header = [
    "# =========================================================================",
    `# GENERATED from Doppler (config: ${config}) at ${now.toISOString()}`,
    "# Do NOT hand-edit. This file is overwritten by every deploy and by",
    "# `npm run env-sync`. Change values in the Doppler dashboard instead.",
    "# =========================================================================",
    "",
    ""
  ].join("\n");
  // Escape sequence, not a literal U+FEFF byte in the source: a literal BOM
  // is invisible in most editors and one autoformat away from silently
  // becoming /^/ (matches nothing, strips no BOM). Spelling it as \uFEFF
  // keeps the intent visible in the diff and immune to whitespace-only edits.
  const body = String(payload).replace(/^\uFEFF/, "");
  return header + body + (body.endsWith("\n") ? "" : "\n");
}

/**
 * Fetch -> validate -> write temp -> atomic rename -> back up. On ANY
 * failure the existing .env is left byte-identical to how it was found.
 * fs.renameSync replaces the destination on Windows (MoveFileEx with
 * MOVEFILE_REPLACE_EXISTING), so the swap is a single-step replace, never
 * a delete-then-write window.
 *
 * .env.bak is written from memory AFTER the rename succeeds, not copied
 * before it. Copy-then-rename could leave a fresh .env.bak behind (or
 * silently overwrite a good prior one) when the rename fails - a failed
 * sync must not touch .env.bak at all.
 */
export function syncEnv({ fetch, root, config = "(unknown)", now = new Date() }) {
  const envPath = path.join(root, ".env");
  const bakPath = path.join(root, ".env.bak");
  const tmpPath = path.join(root, ".env.doppler-tmp");

  let payload;
  try {
    payload = fetch();
  } catch (e) {
    const reason = `doppler fetch failed: ${e.message}`;
    log(`FAILED (closed): ${reason}. .env left as-is.`);
    return { ok: false, changed: false, reason };
  }

  const v = validateEnvPayload(payload);
  if (!v.ok) {
    log(`FAILED (closed): ${v.reason}. .env left as-is.`);
    return { ok: false, changed: false, reason: v.reason };
  }

  // Read the old .env into memory BEFORE the swap; it becomes .env.bak only
  // once the swap has succeeded, so no failure path can touch .env.bak.
  let oldEnv = null;
  try {
    fs.writeFileSync(tmpPath, renderEnvFile(payload, { config, now }), { encoding: "utf8" });
    if (fs.existsSync(envPath)) oldEnv = fs.readFileSync(envPath, "utf8");
    fs.renameSync(tmpPath, envPath);
  } catch (e) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    const reason = `write failed: ${e.message}`;
    log(`FAILED (closed): ${reason}. .env left as-is.`);
    return { ok: false, changed: false, reason };
  }

  if (oldEnv !== null) {
    try {
      fs.writeFileSync(bakPath, oldEnv, { encoding: "utf8" });
    } catch (e) {
      // The sync itself succeeded - .env is the new config. A failed backup
      // write costs the rollback copy, not correctness, so report success
      // and say the backup is missing rather than fail a completed sync.
      log(`.env updated, but writing .env.bak failed (${e.message}) - no backup of the previous file.`);
      return { ok: true, changed: true, reason: "" };
    }
  }

  log(`.env updated from Doppler (config: ${config})${oldEnv !== null ? "; previous file saved to .env.bak" : ""}.`);
  return { ok: true, changed: true, reason: "" };
}

/**
 * Compare the remote config against the local .env by PARSED key/value -
 * dotenv.parse on both sides, so quoting differences ('x' vs "x" vs bare)
 * don't count as changes. Reports key NAMES only: this output goes to a
 * console, and console scrollback is not a place secrets go.
 */
export function diffEnv({ fetch, root }) {
  const envPath = path.join(root, ".env");

  let payload;
  try {
    payload = fetch();
  } catch (e) {
    return { ok: false, changed: false, reason: `doppler fetch failed: ${e.message}`, added: [], removed: [], differing: [] };
  }
  const v = validateEnvPayload(payload);
  if (!v.ok) {
    return { ok: false, changed: false, reason: v.reason, added: [], removed: [], differing: [] };
  }

  const remote = dotenv.parse(payload);
  // Guarded like syncEnv's write path: existsSync passing does not make the
  // read safe (permission flip, .env-as-directory, check/read race), and
  // diffEnv's contract is "never throws". The error message carries no file
  // content - e.message for a failed read names the path and errno only.
  let local;
  try {
    local = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, "utf8")) : {};
  } catch (e) {
    return { ok: false, changed: false, reason: `local .env read failed: ${e.message}`, added: [], removed: [], differing: [] };
  }

  const added = Object.keys(remote).filter((k) => !(k in local)).sort();
  const removed = Object.keys(local).filter((k) => !(k in remote)).sort();
  const differing = Object.keys(remote).filter((k) => k in local && local[k] !== remote[k]).sort();

  return { ok: true, changed: added.length + removed.length + differing.length > 0, reason: "", added, removed, differing };
}

/* ---- CLI ------------------------------------------------------------- */

/** Download the active Doppler config as env-format text. Throws on failure. */
function fetchFromDoppler() {
  const r = spawnSync("doppler", ["secrets", "download", "--no-file", "--format", "env"],
    { encoding: "utf8", windowsHide: true });
  if (r.error) throw new Error(`could not run doppler CLI: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`doppler exited ${r.status}: ${String(r.stderr || "").trim()}`);
  return r.stdout;
}

/** Best-effort name of the active config, for the generated-file header. */
function activeDopplerConfig() {
  try {
    const r = spawnSync("doppler", ["configure", "get", "config", "--plain"],
      { encoding: "utf8", windowsHide: true });
    const name = String(r.stdout || "").trim();
    return r.status === 0 && name ? name : "(unknown)";
  } catch {
    return "(unknown)";
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  // Reject unknown flags early to prevent silent mode flip from read-only to write.
  const recognizedFlags = new Set(["--diff"]);
  const unknownArgs = process.argv.slice(2).filter(arg => arg.startsWith("-") && !recognizedFlags.has(arg));
  if (unknownArgs.length > 0) {
    log(`error: unrecognized argument(s): ${unknownArgs.join(", ")}`);
    process.exit(1);
  }

  if (process.argv.includes("--diff")) {
    const r = diffEnv({ fetch: fetchFromDoppler, root });
    if (!r.ok) { log(`diff failed: ${r.reason}`); process.exit(1); }
    if (!r.changed) {
      log("no differences - local .env matches the Doppler config.");
    } else {
      // Key names only. Values never reach the console.
      if (r.added.length) log(`in Doppler but not local : ${r.added.join(", ")}`);
      if (r.removed.length) log(`local but not in Doppler: ${r.removed.join(", ")}`);
      if (r.differing.length) log(`different value          : ${r.differing.join(", ")}`);
    }
    process.exit(0);
  }
  const r = syncEnv({ fetch: fetchFromDoppler, root, config: activeDopplerConfig() });
  process.exit(r.ok ? 0 : 1);
}
