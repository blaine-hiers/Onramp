import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG, asBool, asInt, asList, asEnum, widen } from "../src/core/config.mjs";

// CONFIG is a snapshot taken at import, so the env-dependent behavior can
// only be exercised in a fresh process. Each of these loads config.mjs in
// a child node with a scrubbed environment and reads the frozen object
// back as JSON.
const CONFIG_URL = new URL("../src/core/config.mjs", import.meta.url).href;

// MCP_ENV_FILE aims the loader at a file that does not exist, so a real
// .env sitting in the repo root cannot leak into these assertions.
const NO_ENV_FILE = join(mkdtempSync(join(tmpdir(), "onramp-config-")), "absent.env");

function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("MCP_")) env[k] = v;
  }
  env.MCP_ENV_FILE = NO_ENV_FILE;
  return env;
}

function loadConfig(env = {}, preamble = "") {
  const script =
    preamble +
    `import(${JSON.stringify(CONFIG_URL)}).then((m) => {` +
    "process.stdout.write(JSON.stringify(m.CONFIG));" +
    "});";
  const res = spawnSync(process.execPath, ["-e", script], {
    env: { ...baseEnv(), ...env },
    encoding: "utf8"
  });
  assert.equal(res.status, 0, `child exited ${res.status}: ${res.stderr}`);
  return { config: JSON.parse(res.stdout), stderr: res.stderr };
}

test("asBool treats a blank string as unset rather than as false", () => {
  // The trap this pins: util.mjs's asBool maps "" to false, and a reader
  // who assumes the same here would conclude that MCP_DRY_RUN= disables
  // dry run. It does not: a blank falls through to the caller's default.
  assert.equal(asBool("", true), true, "blank must not read as false");
  assert.equal(asBool("", false), false, "blank returns the default, whatever it is");
  assert.equal(asBool("false", true), false, "an explicit false is still honored");
});

test("asBool accepts the stringly booleans a launch config actually produces", () => {
  for (const yes of ["true", "TRUE", " 1 ", "yes", "y", "on"]) {
    assert.equal(asBool(yes, false), true, `${JSON.stringify(yes)} should be true`);
  }
  for (const no of ["false", "0", "no", "n", "OFF"]) {
    assert.equal(asBool(no, true), false, `${JSON.stringify(no)} should be false`);
  }
});

test("asBool falls back to the default on a value it cannot parse", () => {
  assert.equal(asBool("flase", true), true, "a typo must not read as false");
  assert.equal(asBool("maybe", false), false);
  assert.equal(asBool(NaN, true), true, "NaN is a broken caller, not a flag");
  assert.equal(asBool(undefined, true), true);
});

test("asInt rejects a numeric-looking string rather than guessing at it", () => {
  assert.equal(asInt("1.9", 7), 7, "no truncation to 1");
  assert.equal(asInt("0x10", 7), 7, "Number() would have read this as 16");
  assert.equal(asInt("1e3", 7), 7);
  assert.equal(asInt("12abc", 7), 7);
  assert.equal(asInt("", 7), 7);
  assert.equal(asInt(undefined, 7), 7);
});

test("asInt clamps a parseable value into its declared range", () => {
  assert.equal(asInt("999", 10, { min: 1, max: 100 }), 100);
  assert.equal(asInt("-5", 10, { min: 1, max: 100 }), 1);
  assert.equal(asInt(" 42 ", 10, { min: 1, max: 100 }), 42);
});

test("asInt returns the default unclamped so a bad default stays visible", () => {
  // Deliberate: a default outside its own bounds is a bug in config.mjs,
  // and clamping it here would hide the bug behind a plausible number.
  assert.equal(asInt("nope", 999, { min: 1, max: 100 }), 999);
});

test("asInt accepts a real number only when it is a safe integer", () => {
  assert.equal(asInt(5, 1), 5);
  assert.equal(asInt(5.5, 1), 1);
  assert.equal(asInt("9007199254740993", 1), 1, "past 2^53 is not a readable bound");
});

test("asList splits on commas, trims, drops empties and de-duplicates", () => {
  assert.deepEqual(asList("a, b ,,a,"), ["a", "b"]);
});

test("asList treats a blank string as unset rather than as an empty list", () => {
  // The trap: there is no way to spell "empty" in one of these vars, on
  // purpose, because every list built from them is a safety list.
  assert.deepEqual(asList("", ["x", "y"]), ["x", "y"]);
  assert.deepEqual(asList(undefined, ["x"]), ["x"]);
});

test("asList preserves case and returns a frozen array", () => {
  const out = asList("Authorization, X-Api-Key");
  assert.deepEqual(out, ["Authorization", "X-Api-Key"]);
  assert.ok(Object.isFrozen(out), "a caller must not be able to mutate a config list");
});

test("asEnum falls back to the safe default instead of widening to a wildcard", () => {
  assert.equal(asEnum("*", ["error", "info"], "error"), "error");
  assert.equal(asEnum("all", ["error", "info"], "error"), "error");
  assert.equal(asEnum("verbose", ["error", "info"], "error"), "error");
  assert.equal(asEnum("", ["error", "info"], "error"), "error");
});

test("asEnum matches a member case-insensitively after trimming", () => {
  assert.equal(asEnum(" INFO ", ["error", "info"], "error"), "info");
});

test("widen adds the env entries to the in-code defaults", () => {
  assert.deepEqual(widen(["a", "b"], "c, d"), ["a", "b", "c", "d"]);
  assert.deepEqual(widen(["a", "b"], ""), ["a", "b"]);
  assert.deepEqual(widen(["a"], "A, a"), ["a"], "case-insensitive de-duplication");
});

test("widen has no syntax that removes or replaces a default entry", () => {
  // A removal syntax was considered and rejected. This pins the absence:
  // "-authorization" is treated as one more literal entry, and the real
  // "authorization" default survives it.
  const out = widen(["authorization"], "-authorization");
  assert.ok(out.includes("authorization"), "the default must survive any input");
  assert.equal(out.length, 2, "the input can only ever add");
  assert.ok(Object.isFrozen(out));
});

test("CONFIG is frozen and so are its list values", () => {
  assert.ok(Object.isFrozen(CONFIG));
  assert.ok(Object.isFrozen(CONFIG.AUDIT_REDACT_KEYS));
  assert.ok(Object.isFrozen(CONFIG.CONFIRM_REQUIRED_TOOLS));
  assert.ok(Object.isFrozen(CONFIG.BLANK_ENV_VARS));
});

test("CONFIG exposes the keys the rest of the server reads", () => {
  for (const key of [
    "SERVER_NAME",
    "TOOLSET",
    "DRY_RUN",
    "CONFIRM_TTL_MS",
    "AUDIT_MAX_BYTES",
    "AUDIT_KEEP_FILES"
  ]) {
    assert.ok(key in CONFIG, `CONFIG is missing ${key}`);
  }
});

test("DRY_RUN defaults to true so a fresh clone cannot cause an outward effect", () => {
  const { config } = loadConfig();
  assert.equal(config.DRY_RUN, true);
});

test("an unreadable MCP_DRY_RUN leaves the dry-run gate closed", () => {
  // FAIL CLOSED: the whole point is that a typo cannot open a gate.
  const { config } = loadConfig({ MCP_DRY_RUN: "flase" });
  assert.equal(config.DRY_RUN, true);
});

test("a blank MCP_DRY_RUN does not turn the dry-run gate off", () => {
  // Set inside the child, not through the spawn environment: Windows
  // cannot carry an empty value in a process environment block.
  const { config, stderr } = loadConfig({}, 'process.env.MCP_DRY_RUN = "";');
  assert.equal(config.DRY_RUN, true, "blank must not read as false");
  assert.deepEqual(config.BLANK_ENV_VARS, ["MCP_DRY_RUN"]);
  assert.match(stderr, /set but empty/, "a blank is reported, not swallowed");
});

test("an unset variable is a different case from a blank one", () => {
  const { config, stderr } = loadConfig();
  assert.deepEqual(config.BLANK_ENV_VARS, [], "unset is never reported as blank");
  assert.equal(stderr, "", "and produces no warning line");
});

test("MCP_DRY_RUN=false does turn dry run off when it is spelled correctly", () => {
  const { config } = loadConfig({ MCP_DRY_RUN: "false" });
  assert.equal(config.DRY_RUN, false);
});

test("CONFIRM_TTL_MS defaults to fifteen minutes and clamps a runaway value", () => {
  assert.equal(loadConfig().config.CONFIRM_TTL_MS, 15 * 60 * 1000);
  const huge = loadConfig({ MCP_CONFIRM_TTL_MS: "99999999" }).config;
  assert.equal(huge.CONFIRM_TTL_MS, 60 * 60 * 1000, "clamped to the ceiling");
  const junk = loadConfig({ MCP_CONFIRM_TTL_MS: "15 minutes" }).config;
  assert.equal(junk.CONFIRM_TTL_MS, 15 * 60 * 1000, "unreadable falls back");
});

test("asEnum falls back to the default when the value is outside the closed set", () => {
  assert.equal(asEnum("trace", ["error", "warn", "info", "debug"], "info"), "info");
  assert.equal(asEnum("DEBUG", ["error", "warn", "info", "debug"], "info"), "debug");
});

test("TOOLSET is trimmed and lowercased for the Windows trailing-space quirk", () => {
  assert.equal(loadConfig({ MCP_TOOLSET: " EXAMPLE " }).config.TOOLSET, "example");
  assert.equal(loadConfig().config.TOOLSET, "all");
});

test("the redaction allowlist widens from the env and never narrows", () => {
  const base = loadConfig().config.AUDIT_REDACT_KEYS;
  const widened = loadConfig({ MCP_AUDIT_REDACT_EXTRA: "x-tenant-key" }).config
    .AUDIT_REDACT_KEYS;
  assert.ok(base.includes("authorization"));
  assert.ok(widened.includes("x-tenant-key"), "the env entry is added");
  for (const key of base) {
    assert.ok(widened.includes(key), `${key} must survive: the set only grows`);
  }
});

test("an env value cannot empty the redaction allowlist", () => {
  // The failure this prevents: a redaction list that a launch config can
  // shorten is a launch config that can make the audit log print tokens.
  const base = loadConfig().config.AUDIT_REDACT_KEYS;
  const blanked = loadConfig({}, 'process.env.MCP_AUDIT_REDACT_EXTRA = "";').config;
  assert.deepEqual(blanked.AUDIT_REDACT_KEYS, base);
});
