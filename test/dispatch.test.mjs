import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/core/config.mjs";
import { dispatch } from "../src/core/dispatch.mjs";
import { gate } from "../src/core/effect.mjs";
import { mintConfirmToken } from "../src/core/confirm.mjs";

// End to end through the REAL dispatch against the REAL registry: lookup,
// schema validation, the ordered gate, the audit records and the handler.
// Nothing is stubbed, because the property worth testing is that a call
// cannot get past one of those stages by accident.
//
// WHERE THE STATE GOES, and why it is not redirected. Both confirm.mjs and
// audit.mjs resolve their storage lazily on first call, but they resolve it
// against the repo root and `dispatch` reaches them through module level
// imports with no injection point. Running dispatch therefore creates
// var/state/confirm-tokens.json and var/logs/audit.jsonl inside the repo.
// Both are gitignored (see .gitignore: `var/`). The factory route,
// createConfirmStore(file) / createAuditLog(root) with a
// mkdtempSync(join(tmpdir(), "onramp-dispatch-")) root, is what the unit
// suites use and is the right tool there, but it cannot reach the instances
// dispatch actually calls, so it is not used here.
//
// This is also the only test file in the suite that writes to the default
// token store, which is what keeps it safe under `node --test` parallelism:
// test/effect.test.mjs deliberately performs no I/O against it, so no other
// process can drop a record this file just minted.

const textOf = (result) => (result?.content ?? []).map((c) => c.text).join("");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MINTING IS RETRIED, and the retry is for the weather rather than for the
// code. `mintConfirmToken` fails CLOSED: when the store cannot be persisted
// it returns "" and example_prepare_delete answers "Could not persist a
// confirmation token", which is the correct and documented behavior. The
// store persists by writing a temp file and renaming it over the target,
// and on Windows a rename over an existing file inside a scanned or indexed
// tree (Documents, a cloud sync folder, a real-time virus scanner) returns
// EPERM for a few milliseconds at a time. Measured on this repo at roughly
// one full suite run in fifty, which is a flake in a test that is trying to
// assert something else entirely. The retry is bounded, it never widens
// what the test accepts, and if every attempt fails the assertion still
// reports the real message.
const MINT_ATTEMPTS = 4;

async function prepareToken(resourceId) {
  let last;
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await pause(10);
    last = await dispatch("example_prepare_delete", { resource_id: resourceId });
    const match = /confirm_token: (\S+)/.exec(textOf(last));
    if (match) return { prepared: last, token: match[1] };
    // Anything other than a storage failure is a real result the caller
    // should see immediately rather than have retried at it.
    if (!/Could not persist/.test(textOf(last))) break;
  }
  assert.fail(`phase 1 did not hand back a confirm_token: ${textOf(last)}`);
}

// Short lived on purpose. These approvals are never spent, so a 15 minute
// ttl would leave them sitting in the repo's token store long after the run
// that made them; a one minute ttl is swept by the next write instead.
async function mintForTest(spec) {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await pause(10);
    const token = mintConfirmToken({ ttlMs: 60_000, ...spec });
    if (token !== "") return token;
  }
  return assert.fail(`the token store could not persist an approval in ${MINT_ATTEMPTS} attempts`);
}

test("the default posture is dry run, which every two-phase test below depends on", () => {
  // CONFIG is frozen at import and MCP_DRY_RUN defaults to true, so there
  // is nothing to arrange. Asserted out loud so that a machine with
  // MCP_DRY_RUN=false in its environment fails here, with an explanation,
  // instead of failing four confusing assertions further down.
  assert.equal(CONFIG.DRY_RUN, true);
});

/* ---- lookup ------------------------------------------------------------ */

test("an unknown tool name comes back as an error result naming the tool", async () => {
  const result = await dispatch("definitely_not_a_tool", {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unknown tool: definitely_not_a_tool/);
});

/* ---- the happy read path ----------------------------------------------- */

test("echo with valid arguments reaches its handler and returns the echoed text", async () => {
  const result = await dispatch("echo", { message: "hello" });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), "echo: hello");
});

/* ---- schema validation, which runs BEFORE the gate --------------------- */

test("a missing required property is rejected by schema validation and the message names the property", async () => {
  const result = await dispatch("echo", {});
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /Invalid arguments for 'echo'/);
  assert.match(text, /message: required property is missing/, "the model has to be told which argument to fix");
});

test("a wrong typed property is rejected by schema validation and the message names the property", async () => {
  const result = await dispatch("echo", { message: 42 });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /Invalid arguments for 'echo'/);
  assert.match(text, /message: expected string, received number/);
});

test("malformed arguments are rejected by the schema before the gate is consulted", async () => {
  // The ordering assertion. This call is wrong in two independent ways: a
  // wrong typed resource_id, and a confirm token that could never validate.
  // If the gate ran first the caller would be told about the approval; the
  // schema error is what must come back, because arguments that cannot be
  // trusted must not be used to compute an authorization decision.
  const result = await dispatch("example_delete", { resource_id: 42, confirm_token: "garbage" });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /Invalid arguments for 'example_delete'/);
  assert.match(text, /resource_id: expected string, received number/);
  assert.equal(/Confirmation rejected/.test(text), false, "validation must run before the approval step");
});

/* ---- the two-phase flow ------------------------------------------------ */

test("phase one mints a token and phase two previews it without spending it", async () => {
  const { prepared, token } = await prepareToken("rec-1");
  assert.equal(prepared.isError, undefined);
  assert.match(textOf(prepared), /Ready to delete 'rec-1'/);

  const first = await dispatch("example_delete", { resource_id: "rec-1", confirm_token: token });
  assert.equal(first.isError, undefined, textOf(first));
  const firstText = textOf(first);
  assert.match(firstText, /^DRY RUN\./);
  assert.match(firstText, /against rec-1/);
  assert.match(firstText, /no approval was consumed/);

  // The property that makes previewing usable: if the dry run burned the
  // token, operators would learn to skip previewing, which defeats the
  // entire two-phase gate. So a second identical call must still preview.
  const second = await dispatch("example_delete", { resource_id: "rec-1", confirm_token: token });
  assert.equal(second.isError, undefined, "a dry run must not consume the approval");
  assert.match(textOf(second), /^DRY RUN\./);
});

test("a token minted for one record is refused when spent on another", async () => {
  const { token } = await prepareToken("rec-1");

  const result = await dispatch("example_delete", { resource_id: "rec-2", confirm_token: token });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Confirmation rejected: resource_mismatch/);
});

test("a garbage confirm token is refused", async () => {
  const result = await dispatch("example_delete", {
    resource_id: "rec-1",
    confirm_token: "not-a-token-anyone-minted"
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Confirmation rejected: not_found/);
});

test("example_delete with no confirm token at all never reaches the handler", async () => {
  // Caught by the schema here rather than by the gate, because this tool
  // declares confirm_token as required. That is the earlier and better of
  // the two refusals, and the gate's own no-token denial is pinned
  // directly in test/effect.test.mjs. Either way the handler does not run.
  const result = await dispatch("example_delete", { resource_id: "rec-1" });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /Invalid arguments for 'example_delete'/);
  assert.match(text, /confirm_token: required property is missing/);
  assert.equal(/Deleted/.test(text), false, "the handler must not have run");
});

test("an empty confirm token clears the schema but is stopped by the gate", async () => {
  const result = await dispatch("example_delete", { resource_id: "rec-1", confirm_token: "" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /requires a confirm_token/);
});

/* ---- the payload binding, at the gate ---------------------------------- */
//
// These two drive `gate` directly with a stub tool rather than going
// through dispatch, because the example tools declare
// additionalProperties: false with only resource_id and confirm_token, so
// there is no argument left that can differ between mint and spend while
// still passing the schema. They live in THIS file, not in
// test/effect.test.mjs, because they mint into the repo level default token
// store and keeping every such write in one process is what makes the
// suite safe to run in parallel.

test("a token bound to these exact arguments is allowed through the approval step", async () => {
  const args = { resource_id: "rec-9", body: "approved copy" };
  const token = await mintForTest({ resourceId: "rec-9", payload: args });

  const decision = await gate({
    name: "fake_commit",
    tool: {},
    effect: "irreversible",
    args: { ...args, confirm_token: token }
  });
  assert.equal(decision.allow, true, decision.reason);
  assert.equal(decision.deniedAt, null);
  assert.equal(decision.dryRun, true);
});

test("a token bound to one payload is refused when the payload is swapped underneath it", async () => {
  const token = await mintForTest({
    resourceId: "rec-9",
    payload: { resource_id: "rec-9", body: "approved copy" }
  });

  const decision = await gate({
    name: "fake_commit",
    tool: {},
    effect: "irreversible",
    args: { resource_id: "rec-9", body: "swapped copy", confirm_token: token }
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.deniedAt, "approval");
  assert.match(decision.reason, /payload_mismatch/, "approval was granted for these bytes and no others");
});
