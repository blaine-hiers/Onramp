//
// Single home for runtime-output locations. Everything the server and its
// workers write at runtime — state files, logs, dated reports — lives under
// var/ so the repo root stays code + config only.
//
// Directory creation and legacy migration happen lazily, at the first call
// that resolves a path, never at import time. safety.mjs, learn.mjs and
// exemplars.mjs resolve their paths once at module load behind an env
// override; under `node --test` the overrides from scripts/setup-test-env.mjs
// win, so these helpers are never invoked and the suite does no I/O here.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function createPaths(root, { rename = renameSync } = {}) {
  const dirs = {
    state: join(root, "var", "state"),
    logs: join(root, "var", "logs"),
    reports: join(root, "var", "reports"),
  };

  function resolvePath(kind, name) {
    const dir = dirs[kind];
    mkdirSync(dir, { recursive: true });
    const next = join(dir, name);
    const legacy = join(root, name);
    if (!existsSync(next) && existsSync(legacy)) {
      // One-time cutover: a file the old code left at the repo root moves to
      // its new home the first time anything asks for it. A concurrent worker
      // may win the same rename; losing that race is fine.
      try {
        rename(legacy, next);
      } catch (err) {
        // Never fatal: an un-migrated legacy file is recoverable by hand, but a throw
        // here happens at MODULE LOAD in safety.mjs/learn.mjs and takes the process
        // down before any alert or preflight can report it.
        if (err.code !== "ENOENT") {
          console.error(`[paths] could not migrate ${legacy} -> ${next}: ${err.code || err.message}`);
        }
      }
    }
    return next;
  }

  return {
    stateDir: dirs.state,
    logsDir: dirs.logs,
    reportsDir: dirs.reports,
    statePath: (name) => resolvePath("state", name),
    logPath: (name) => resolvePath("logs", name),
    reportPath: (name) => resolvePath("reports", name),
  };
}

const defaults = createPaths(ROOT);
export const statePath = defaults.statePath;
export const logPath = defaults.logPath;
export const reportPath = defaults.reportPath;
