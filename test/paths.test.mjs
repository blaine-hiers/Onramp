import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaths, ROOT, statePath } from "../src/core/paths.mjs";

test("module exports the expected shape", () => {
  assert.equal(typeof ROOT, "string");
  assert.equal(typeof statePath, "function");
});

test("statePath creates var/state lazily and returns the joined path", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  const p = createPaths(root);
  assert.ok(!existsSync(join(root, "var", "state")));
  const out = p.statePath("example-state.json");
  assert.equal(out, join(root, "var", "state", "example-state.json"));
  assert.ok(existsSync(join(root, "var", "state")));
});

test("legacy root file migrates on first resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  writeFileSync(join(root, "example-state.json"), '{"a":1}');
  const p = createPaths(root);
  const out = p.statePath("example-state.json");
  assert.ok(!existsSync(join(root, "example-state.json")));
  assert.equal(readFileSync(out, "utf8"), '{"a":1}');
});

test("migration never overwrites an existing new-home file", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  mkdirSync(join(root, "var", "logs"), { recursive: true });
  writeFileSync(join(root, "var", "logs", "a.log"), "new");
  writeFileSync(join(root, "a.log"), "old");
  const p = createPaths(root);
  assert.equal(readFileSync(p.logPath("a.log"), "utf8"), "new");
  assert.ok(existsSync(join(root, "a.log"))); // legacy left in place
});

test("resolution is idempotent and tolerates a vanished legacy file", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  const p = createPaths(root);
  assert.equal(p.reportPath("r.md"), p.reportPath("r.md"));
});

test("a renameSync failure other than ENOENT is swallowed, not thrown", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  writeFileSync(join(root, "example-state.json"), '{"a":1}');
  const busyRename = () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  };
  const p = createPaths(root, { rename: busyRename });
  let out;
  assert.doesNotThrow(() => {
    out = p.statePath("example-state.json");
  });
  assert.equal(out, join(root, "var", "state", "example-state.json"));
  assert.ok(existsSync(join(root, "example-state.json"))); // legacy file untouched - migration failed
});
