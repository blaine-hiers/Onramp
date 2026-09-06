import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/core/config.mjs";
import {
  EFFECT_CLASSES,
  CONFIRM_ARG,
  isEffectClass,
  requiresApproval,
  resourceIdFor,
  approvalPayload,
  payloadDigest,
  gate
} from "../src/core/effect.mjs";

// This file deliberately performs NO I/O against the repo-level default
// token store or audit log. Two reasons:
//
//   1. `node --test` runs one child process per file, in parallel, and the
//      default confirm store is a single file under var/state/ shared by
//      every process. A mint here could interleave with a mint in
//      test/dispatch.test.mjs and drop the other file's record, which is a
//      flake nobody would be able to reproduce.
//   2. Everything below is a unit of the gate itself, and the gate's
//      decisions are observable without a real approval on disk.
//
// The consequence: the "a valid token bound to these exact arguments is
// allowed / a token bound to a different payload is refused" pair lives in
// test/dispatch.test.mjs, which already owns the default store. The store
// level payload binding is covered separately in test/confirm.test.mjs.

/* ---- effect classes ---------------------------------------------------- */

test("exactly three effect classes are declared, and the list is frozen", () => {
  assert.deepEqual([...EFFECT_CLASSES], ["read", "write", "irreversible"]);
  assert.equal(Object.isFrozen(EFFECT_CLASSES), true, "a caller must not be able to add a class");
});

test("isEffectClass accepts the three declared classes and rejects everything else", () => {
  for (const cls of ["read", "write", "irreversible"]) {
    assert.equal(isEffectClass(cls), true, `${cls} is a declared class`);
  }
  // "reads" is the near miss that matters: a plural typo in a tool record
  // must never be waved through as "probably a read".
  for (const bad of ["reads", "Read", "READ", "write ", "", " ", "delete", null, 0, 1, true, ["read"], { effect: "read" }]) {
    assert.equal(isEffectClass(bad), false, `${JSON.stringify(bad)} is not a declared class`);
  }
  assert.equal(isEffectClass(undefined), false, "an undeclared class is not a class");
});

test("only irreversible requires an approval", () => {
  assert.equal(requiresApproval("irreversible"), true);
  assert.equal(requiresApproval("write"), false, "requiring a token for every write turns approval into a rubber stamp");
  assert.equal(requiresApproval("read"), false);
  assert.equal(requiresApproval(undefined), false);
  assert.equal(requiresApproval("reads"), false);
});

test("the confirm argument is spelled confirm_token on the wire", () => {
  // Pinned because the schema of every irreversible tool declares this
  // literal name, and the gate strips it by this name. The two have to
  // agree or no token can ever be spent.
  assert.equal(CONFIRM_ARG, "confirm_token");
});

/* ---- the approval payload ---------------------------------------------- */

test("approvalPayload strips the confirm token and leaves every other argument untouched", () => {
  // THE property the whole binding rests on. The token cannot be part of
  // the payload it authorizes: include it and the hash covers the very
  // value being checked, so no token could ever match. Everything else has
  // to survive byte for byte, because a payload that quietly loses a field
  // between mint and spend is a payload nobody actually approved.
  const args = {
    resource_id: "rec-1",
    confirm_token: "tok-abc",
    body: "delete it",
    count: 3,
    flag: false,
    nested: { a: [1, 2, { b: null }] },
    empty: "",
    zero: 0
  };
  assert.deepEqual(approvalPayload(args), {
    resource_id: "rec-1",
    body: "delete it",
    count: 3,
    flag: false,
    nested: { a: [1, 2, { b: null }] },
    empty: "",
    zero: 0
  });
});

test("approvalPayload does not mutate the arguments it was handed", () => {
  const args = { resource_id: "rec-1", confirm_token: "tok-abc" };
  approvalPayload(args);
  assert.equal(args.confirm_token, "tok-abc", "the caller still needs the token to spend it");
});

test("approvalPayload of nothing is an empty payload rather than a throw", () => {
  assert.deepEqual(approvalPayload(undefined), {});
  assert.deepEqual(approvalPayload(null), {});
  assert.deepEqual(approvalPayload({}), {});
});

test("a payload with no token hashes the same as the same payload carrying one", () => {
  // The mint side never sees a token and the spend side always does, so
  // the two must land on the same digest or the binding is unusable.
  const minted = approvalPayload({ resource_id: "rec-1" });
  const spent = approvalPayload({ resource_id: "rec-1", confirm_token: "tok-abc" });
  assert.equal(payloadDigest(minted), payloadDigest(spent));
  assert.notEqual(payloadDigest(minted), payloadDigest({ resource_id: "rec-2" }));
});

/* ---- resource identity ------------------------------------------------- */

test("resourceIdFor falls back to the resource_id argument", () => {
  assert.equal(resourceIdFor(undefined, { resource_id: "rec-9" }), "rec-9");
  assert.equal(resourceIdFor({}, { resource_id: "rec-9" }), "rec-9");
  assert.equal(resourceIdFor({}, { resource_id: 42 }), "42", "the id is always compared as a string");
  assert.equal(resourceIdFor({}, {}), "");
  assert.equal(resourceIdFor({}, undefined), "");
});

test("resourceIdFor prefers a tool's own resourceId resolver", () => {
  const tool = { resourceId: (args) => args.thread_id };
  assert.equal(resourceIdFor(tool, { thread_id: "t-1", resource_id: "ignored" }), "t-1");
  assert.equal(resourceIdFor({ resourceId: () => null }, { resource_id: "ignored" }), "");
  assert.equal(resourceIdFor({ resourceId: () => undefined }, { resource_id: "ignored" }), "");
  assert.equal(resourceIdFor({ resourceId: () => 7 }, {}), "7");
});

test("a resourceId resolver that throws yields an empty id instead of crashing the gate", () => {
  const tool = {
    resourceId: () => {
      throw new Error("resolver blew up");
    }
  };
  let id;
  assert.doesNotThrow(() => {
    id = resourceIdFor(tool, { resource_id: "rec-1" });
  });
  // Empty, NOT the resource_id fallback. An empty id cannot match any
  // minted approval, so a broken resolver fails the call closed rather
  // than silently authorizing a different target than the tool meant.
  assert.equal(id, "");
});

/* ---- the ordered gate -------------------------------------------------- */
//
// ONE TEST PER DENIAL STEP, and each one asserts on `deniedAt` rather than
// on `allow` alone. That is the whole point: the step name is the contract.
// Reordering the pipeline in src/core/effect.mjs, or folding two steps
// together, breaks a named test here instead of quietly changing what the
// server permits while every boolean assertion still passes.
//
// The "accountability" step has no test in this file on purpose. It only
// runs on the live path (`dryRun === false`), CONFIG is frozen at import,
// and `gate` reaches `auditWritable` through a module level import with no
// injection point, so there is no way to drive it from here without
// mutating the frozen snapshot. Its own behavior is covered in
// test/audit.test.mjs.

test("an unknown effect class is denied at the class step", async () => {
  const decision = await gate({ name: "broken_tool", tool: {}, effect: "reads", args: {} });
  assert.equal(decision.allow, false);
  assert.equal(decision.deniedAt, "class", "a misspelled class must not fall through to a later step");
  assert.match(decision.reason, /no valid effect class/);
});

test("a missing effect class is denied at the class step", async () => {
  const decision = await gate({ name: "broken_tool", tool: {}, effect: undefined, args: {} });
  assert.equal(decision.allow, false);
  assert.equal(decision.deniedAt, "class");
  assert.match(decision.reason, /broken_tool/, "the denial names the offending tool");
});

test("a read is allowed immediately, is never a dry run, and hands back a consume that is safe to call", async () => {
  const decision = await gate({ name: "echo", tool: {}, effect: "read", args: { message: "hi" } });
  assert.equal(decision.allow, true);
  assert.equal(decision.deniedAt, null);
  // dryRun is false for a read even though CONFIG.DRY_RUN is true: a read
  // performs no outward effect, so there is no effect to preview.
  assert.equal(decision.dryRun, false, "a read is never previewed, it just runs");
  assert.equal(typeof decision.consume, "function");
  assert.deepEqual(decision.consume(), { ok: true, reason: "" }, "consume must be a safe no-op on a read");
});

test("an irreversible tool called with no confirm token is denied at the approval step", async () => {
  const decision = await gate({
    name: "example_delete",
    tool: {},
    effect: "irreversible",
    args: { resource_id: "rec-1" }
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.deniedAt, "approval");
  assert.match(decision.reason, /requires a confirm_token/);
  assert.match(decision.reason, /prepare tool/, "the denial says how to obtain one");
});

test("an empty confirm token is denied at the approval step rather than treated as absent-but-fine", async () => {
  const decision = await gate({
    name: "example_delete",
    tool: {},
    effect: "irreversible",
    args: { resource_id: "rec-1", confirm_token: "" }
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.deniedAt, "approval");
});

test("a confirm token that does not match anything the server minted is denied at the approval step", async () => {
  // A well formed looking token nobody ever minted. It cannot validate
  // against the payload it is presented with, so the gate has to stop at
  // approval and say so. Whether the store answers not_found, expired or
  // payload_mismatch is confirm.mjs's business; what this pins is the STEP.
  const decision = await gate({
    name: "example_delete",
    tool: {},
    effect: "irreversible",
    args: { resource_id: "rec-1", confirm_token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.deniedAt, "approval", "a bad token is an approval failure, not a class or mode failure");
  assert.match(decision.reason, /Confirmation rejected/);
});

test("a write needs no approval and is previewed in the default dry run posture", async () => {
  // The write class exists precisely so that it does NOT have to carry a
  // token. This is the assertion that would catch someone widening
  // requiresApproval to cover it.
  const decision = await gate({ name: "example_write", tool: {}, effect: "write", args: { a: 1 } });
  assert.equal(decision.allow, true);
  assert.equal(decision.deniedAt, null);
  assert.equal(decision.dryRun, CONFIG.DRY_RUN);
  assert.deepEqual(decision.consume(), { ok: true, reason: "" });
});
