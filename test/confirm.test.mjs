import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createConfirmStore,
  mintConfirmToken,
  validateConfirmToken,
  consumeConfirmToken
} from "../src/core/confirm.mjs";

// One disposable state file plus a clock the test drives by hand. The clock
// is a mutable box so a test can jump time forward after minting without
// rebuilding the store.
function makeStore(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "onramp-confirm-"));
  const clock = { ms: 1_700_000_000_000 };
  const file = join(dir, "confirm-tokens.json");
  const store = createConfirmStore(file, { now: () => clock.ms, ...overrides });
  return { dir, file, clock, store };
}

test("module exports bound default functions alongside the factory", () => {
  assert.equal(typeof createConfirmStore, "function");
  assert.equal(typeof mintConfirmToken, "function");
  assert.equal(typeof validateConfirmToken, "function");
  assert.equal(typeof consumeConfirmToken, "function");
});

test("minting then consuming the same resource and payload succeeds", () => {
  const { store } = makeStore();
  const payload = { to: "ops@example.com", body: "restart the queue" };
  const token = store.mintConfirmToken({ resourceId: "msg-1", payload });
  assert.equal(typeof token, "string");
  assert.ok(token.length > 20);
  assert.deepEqual(store.consumeConfirmToken(token, { resourceId: "msg-1", payload }), {
    ok: true,
    reason: ""
  });
});

test("a payload mutated between mint and consume is rejected", () => {
  const { store } = makeStore();
  const token = store.mintConfirmToken({
    resourceId: "msg-1",
    payload: { to: "ops@example.com", body: "restart the queue" }
  });
  const result = store.consumeConfirmToken(token, {
    resourceId: "msg-1",
    payload: { to: "attacker@example.com", body: "restart the queue" }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "payload_mismatch");
});

test("a resource id that does not match the minted one is rejected", () => {
  const { store } = makeStore();
  const payload = { body: "delete it" };
  const token = store.mintConfirmToken({ resourceId: "draft-4", payload });
  const result = store.consumeConfirmToken(token, { resourceId: "draft-900", payload });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "resource_mismatch");
});

test("a token past its ttl is rejected as expired", () => {
  const { store, clock } = makeStore();
  const payload = { body: "ship it" };
  const token = store.mintConfirmToken({ resourceId: "msg-1", payload, ttlMs: 60_000 });
  clock.ms += 59_000;
  assert.equal(store.validateConfirmToken(token, { resourceId: "msg-1", payload }).ok, true);
  clock.ms += 2_000;
  const result = store.consumeConfirmToken(token, { resourceId: "msg-1", payload });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "expired");
});

test("a token is single use, so a second consume is rejected", () => {
  const { store } = makeStore();
  const payload = { body: "wipe the index" };
  const token = store.mintConfirmToken({ resourceId: "index-1", payload });
  assert.equal(store.consumeConfirmToken(token, { resourceId: "index-1", payload }).ok, true);
  const second = store.consumeConfirmToken(token, { resourceId: "index-1", payload });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_consumed");
});

test("validating does not consume, so a validate followed by a consume still succeeds", () => {
  const { store } = makeStore();
  const payload = { body: "send the invoice" };
  const token = store.mintConfirmToken({ resourceId: "inv-7", payload });
  const expected = { resourceId: "inv-7", payload };
  assert.equal(store.validateConfirmToken(token, expected).ok, true);
  assert.equal(store.validateConfirmToken(token, expected).ok, true);
  assert.equal(store.consumeConfirmToken(token, expected).ok, true);
});

test("validating writes nothing to the store file", () => {
  const { store, file } = makeStore();
  const payload = { body: "no side effects" };
  const token = store.mintConfirmToken({ resourceId: "r-1", payload });
  const before = readFileSync(file, "utf8");
  store.validateConfirmToken(token, { resourceId: "r-1", payload });
  assert.equal(readFileSync(file, "utf8"), before);
});

test("two payloads that would redact to the same preview are still distinguished", () => {
  const { store } = makeStore();
  const approved = { action: "rotate", apiKey: "sk-live-benign" };
  const swapped = { action: "rotate", apiKey: "sk-live-attacker" };
  const token = store.mintConfirmToken({ resourceId: "key-1", payload: approved });
  const result = store.consumeConfirmToken(token, { resourceId: "key-1", payload: swapped });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "payload_mismatch");
});

test("key order in an equivalent payload does not cause a false rejection", () => {
  const { store } = makeStore();
  const token = store.mintConfirmToken({ resourceId: "r-1", payload: { a: 1, b: { c: 2, d: 3 } } });
  const roundTripped = { b: { d: 3, c: 2 }, a: 1 };
  assert.equal(store.consumeConfirmToken(token, { resourceId: "r-1", payload: roundTripped }).ok, true);
});

test("a token nobody minted is rejected, and so is a non-string token", () => {
  const { store } = makeStore();
  store.mintConfirmToken({ resourceId: "r-1", payload: { a: 1 } });
  assert.equal(store.validateConfirmToken("token-1", { resourceId: "r-1", payload: { a: 1 } }).reason, "not_found");
  assert.equal(store.validateConfirmToken("", { resourceId: "r-1", payload: { a: 1 } }).reason, "malformed_token");
  assert.equal(store.validateConfirmToken(null, { resourceId: "r-1", payload: { a: 1 } }).reason, "malformed_token");
});

test("minted tokens are unguessable and never repeat", () => {
  const { store } = makeStore();
  const seen = new Set();
  for (let i = 0; i < 25; i += 1) {
    const token = store.mintConfirmToken({ resourceId: `r-${i}`, payload: { i } });
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
    seen.add(token);
  }
  assert.equal(seen.size, 25);
});

test("a non-finite ttl falls back to the default instead of minting an immortal token", () => {
  const { store, clock } = makeStore();
  const payload = { a: 1 };
  const token = store.mintConfirmToken({ resourceId: "r-1", payload, ttlMs: Number.NaN });
  assert.equal(store.validateConfirmToken(token, { resourceId: "r-1", payload }).ok, true);
  clock.ms += 15 * 60 * 1000 + 1;
  assert.equal(store.validateConfirmToken(token, { resourceId: "r-1", payload }).reason, "expired");
});

test("the store is persisted as a versioned envelope with no temp file left behind", () => {
  const { store, file, dir } = makeStore();
  const token = store.mintConfirmToken({ resourceId: "r-1", payload: { a: 1 } });
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].consumedAt, null);
  assert.equal(typeof parsed.records[0].payloadSha256, "string");
  assert.equal(parsed.records[0].payloadSha256.length, 64);
  assert.equal(typeof parsed.records[0].tokenSha256, "string");
  assert.equal(parsed.records[0].tokenSha256.length, 64);
  assert.deepEqual(readdirSync(dir), ["confirm-tokens.json"]);
});

test("the raw token is never written to disk, only its digest", () => {
  const { store, file } = makeStore();
  const token = store.mintConfirmToken({ resourceId: "r-1", payload: { a: 1 } });
  const raw = readFileSync(file, "utf8");
  // The property, stated as an assertion: a reader of the store file learns
  // that an approval exists and what it is bound to, but cannot present it.
  assert.ok(token.length > 0, "a token was issued");
  assert.equal(raw.includes(token), false, "the token itself must not appear in the store");
  assert.equal(JSON.parse(raw).records[0].token, undefined, "no legacy token field");
});

test("expired records are swept out of the file by the next write", () => {
  const { store, file, clock } = makeStore();
  store.mintConfirmToken({ resourceId: "old", payload: { a: 1 }, ttlMs: 60_000 });
  clock.ms += 61_000;
  store.mintConfirmToken({ resourceId: "new", payload: { b: 2 } });
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].resourceId, "new");
});

test("a corrupt store file fails closed rather than accepting a token", () => {
  const { store, file } = makeStore();
  const payload = { a: 1 };
  const token = store.mintConfirmToken({ resourceId: "r-1", payload });
  writeFileSync(file, "{ truncated");
  assert.equal(store.validateConfirmToken(token, { resourceId: "r-1", payload }).reason, "not_found");
});

test("a failed write fails closed at mint and at consume", () => {
  const { store, file, clock } = makeStore();
  const payload = { a: 1 };
  const token = store.mintConfirmToken({ resourceId: "r-1", payload });

  const brokenRename = () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  const broken = createConfirmStore(file, { now: () => clock.ms, rename: brokenRename });

  assert.equal(broken.mintConfirmToken({ resourceId: "r-2", payload }), "");
  const result = broken.consumeConfirmToken(token, { resourceId: "r-1", payload });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "storage_error");
  // The token must still be spendable once the disk recovers: a consume
  // that could not be recorded must not half-happen.
  assert.equal(store.consumeConfirmToken(token, { resourceId: "r-1", payload }).ok, true);
  assert.ok(existsSync(file));
});
