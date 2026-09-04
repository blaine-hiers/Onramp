/**
 * env-sync unit tests. No network, no doppler CLI - everything injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { validateEnvPayload, renderEnvFile } =
  await import("../scripts/env-sync.mjs");

test("validateEnvPayload rejects an empty payload", () => {
  const v = validateEnvPayload("   \n");
  assert.equal(v.ok, false);
  assert.match(v.reason, /empty/i);
});

test("validateEnvPayload rejects a payload without the sentinel", () => {
  const v = validateEnvPayload("SOME_VAR=1\nOTHER=2\n");
  assert.equal(v.ok, false);
  assert.match(v.reason, /MCP_SERVER_NAME/);
});

test("validateEnvPayload accepts a payload carrying the sentinel", () => {
  const v = validateEnvPayload('MCP_SERVER_NAME="example-mcp"\nMCP_TOOLSET="all"\n');
  assert.equal(v.ok, true);
});

test("renderEnvFile prepends a do-not-hand-edit header and keeps the payload", () => {
  const out = renderEnvFile('A="1"', { config: "prd", now: new Date("2026-08-17T00:00:00Z") });
  assert.match(out, /GENERATED from Doppler/);
  assert.match(out, /config: prd/);
  assert.match(out, /Do NOT hand-edit/);
  assert.ok(out.includes('A="1"'));
  assert.ok(out.endsWith("\n"), "must end with a newline");
  // Every header line must be a comment, or dotenv would try to parse it.
  const headerLines = out.split('A="1"')[0].trim().split("\n");
  for (const l of headerLines) assert.ok(l.startsWith("#"), `not a comment: ${l}`);
});

// Passes both before and after the \uFEFF-escape fix (behavior is unchanged);
// its value is guarding the strip regex against silently becoming /^/ again.
test("renderEnvFile strips a leading BOM from the payload", () => {
  const out = renderEnvFile("\uFEFF" + 'A="1"', { config: "prd", now: new Date("2026-08-17T00:00:00Z") });
  assert.ok(out.includes('A="1"'));
  assert.ok(!out.includes("\uFEFF"), "rendered output must not contain a BOM");
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { syncEnv } = await import("../scripts/env-sync.mjs");

const GOOD = 'MCP_SERVER_NAME="example-mcp"\nMCP_TOOLSET="all"\n';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "env-sync-test-"));
}

test("syncEnv replaces .env and backs up the old one", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, ".env"), "OLD=1\n");
  const r = syncEnv({ fetch: () => GOOD, root, config: "prd", now: new Date("2026-08-17T00:00:00Z") });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  const env = fs.readFileSync(path.join(root, ".env"), "utf8");
  assert.match(env, /GENERATED from Doppler/);
  assert.ok(env.includes('MCP_SERVER_NAME="example-mcp"'));
  assert.equal(fs.readFileSync(path.join(root, ".env.bak"), "utf8"), "OLD=1\n");
  assert.ok(!fs.existsSync(path.join(root, ".env.doppler-tmp")), "temp file must not linger");
});

test("syncEnv works on a machine with no .env yet (no .env.bak created)", () => {
  const root = tmpRoot();
  const r = syncEnv({ fetch: () => GOOD, root });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(root, ".env")));
  assert.ok(!fs.existsSync(path.join(root, ".env.bak")));
});

test("syncEnv fails closed when the fetch throws: .env untouched", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, ".env"), "OLD=1\n");
  const r = syncEnv({ fetch: () => { throw new Error("doppler unreachable"); }, root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /doppler unreachable/);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "OLD=1\n");
  assert.ok(!fs.existsSync(path.join(root, ".env.bak")), "no backup on a failed sync");
});

test("syncEnv fails closed when the rename throws: .env untouched, no .env.bak", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, ".env"), "OLD=1\n");
  // The script and this test share the same node:fs module object, so a
  // monkeypatch here is seen by syncEnv. Restore in finally, always.
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error("EBUSY: resource busy or locked"); };
  let r;
  try {
    r = syncEnv({ fetch: () => GOOD, root });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(r.ok, false);
  assert.match(r.reason, /EBUSY/);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "OLD=1\n", ".env must be byte-identical");
  assert.ok(!fs.existsSync(path.join(root, ".env.bak")), "no .env.bak on a failed sync");
  assert.ok(!fs.existsSync(path.join(root, ".env.doppler-tmp")), "temp file must not linger");
});

test("syncEnv fails closed on an invalid payload: .env untouched", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, ".env"), "OLD=1\n");
  const r = syncEnv({ fetch: () => "NOT_OURS=1\n", root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sentinel/);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "OLD=1\n");
});

const { diffEnv } = await import("../scripts/env-sync.mjs");

test("diffEnv reports added/removed/differing key NAMES and writes nothing", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, ".env"), 'MCP_SERVER_NAME="example-mcp"\nONLY_LOCAL=x\nMCP_TOOLSET=all\n');
  const remote = 'MCP_SERVER_NAME="example-mcp"\nMCP_TOOLSET="system"\nONLY_REMOTE="y"\n';
  const r = diffEnv({ fetch: () => remote, root });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ["ONLY_REMOTE"]);
  assert.deepEqual(r.removed, ["ONLY_LOCAL"]);
  assert.deepEqual(r.differing, ["MCP_TOOLSET"]);
  // Reported values (if any leaked) must never surface in the result object.
  assert.ok(!JSON.stringify(r).includes("example-mcp"));
  // And nothing was written.
  assert.match(fs.readFileSync(path.join(root, ".env"), "utf8"), /ONLY_LOCAL/);
  assert.ok(!fs.existsSync(path.join(root, ".env.bak")));
});

test("diffEnv on identical configs reports changed:false", () => {
  const root = tmpRoot();
  const same = 'MCP_SERVER_NAME="example-mcp"\nMCP_TOOLSET="all"\n';
  fs.writeFileSync(path.join(root, ".env"), same);
  const r = diffEnv({ fetch: () => same, root });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
});

test("diffEnv with no local .env treats every remote key as added", () => {
  const root = tmpRoot();
  const r = diffEnv({ fetch: () => 'MCP_SERVER_NAME="example-mcp"\n', root });
  assert.equal(r.ok, true);
  assert.deepEqual(r.added, ["MCP_SERVER_NAME"]);
});

test("diffEnv fails closed on an invalid payload", () => {
  const root = tmpRoot();
  const r = diffEnv({ fetch: () => "", root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/i);
});

test("diffEnv never throws when the local .env read fails", () => {
  const root = tmpRoot();
  // .env as a DIRECTORY: existsSync passes, readFileSync throws (EISDIR).
  fs.mkdirSync(path.join(root, ".env"));
  let r;
  assert.doesNotThrow(() => {
    r = diffEnv({ fetch: () => 'MCP_SERVER_NAME="example-mcp"\n', root });
  });
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.match(r.reason, /local \.env read failed/);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.differing, []);
});
