import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAuditLog,
  AuditUnavailableError,
  auditWritable,
  refuseIfUnauditable,
  auditIntent,
  auditOutcome,
} from "../src/core/audit.mjs";

// Every test gets its own root. The audit log is a real file on disk and
// rotation renames it, so a shared root would make read-back assertions
// depend on the order node --test happened to run the file in.
function tempRoot() {
  return mkdtempSync(join(tmpdir(), "onramp-audit-"));
}

function logFile(root) {
  return join(root, "var", "logs", "audit.jsonl");
}

// Parse the JSONL back into records. Blank lines are filtered rather than
// tolerated by JSON.parse, so a stray empty line would fail loudly here
// instead of silently becoming `null` in the middle of an assertion.
function readRecords(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("module exports the expected shape", () => {
  assert.equal(typeof createAuditLog, "function");
  assert.equal(typeof auditWritable, "function");
  assert.equal(typeof refuseIfUnauditable, "function");
  assert.equal(typeof auditIntent, "function");
  assert.equal(typeof auditOutcome, "function");
  assert.ok(AuditUnavailableError.prototype instanceof Error);
});

test("a log path that cannot be created reports not writable with a reason", () => {
  // A regular file standing where a parent directory needs to be. mkdir
  // under it fails on every platform, which is the cheapest portable
  // stand-in for a read-only mount or a denied directory ACL.
  const base = tempRoot();
  const blocker = join(base, "blocker");
  writeFileSync(blocker, "not a directory");
  const audit = createAuditLog(join(blocker, "root"));
  const result = audit.auditWritable();
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});

test("a log path that is not a regular file reports not writable", () => {
  // Windows openSync(dir, "a") succeeds against a directory and only the
  // first real byte fails, so this asserts the explicit file-type check
  // rather than trusting open() to have caught it.
  const root = tempRoot();
  mkdirSync(join(root, "var", "logs"), { recursive: true });
  mkdirSync(logFile(root));
  const audit = createAuditLog(root);
  const result = audit.auditWritable();
  assert.equal(result.ok, false);
  assert.ok(/not a regular file/.test(result.reason));
});

test("refuseIfUnauditable throws a typed error when the log is unwritable", () => {
  const root = tempRoot();
  mkdirSync(join(root, "var", "logs"), { recursive: true });
  mkdirSync(logFile(root));
  const audit = createAuditLog(root);
  assert.throws(() => audit.refuseIfUnauditable(), (err) => {
    assert.ok(err instanceof AuditUnavailableError);
    assert.equal(err.code, "AUDIT_UNAVAILABLE");
    assert.ok(err.reason.length > 0);
    return true;
  });
});

test("refuseIfUnauditable stays silent when the log is writable", () => {
  const audit = createAuditLog(tempRoot());
  assert.doesNotThrow(() => audit.refuseIfUnauditable());
});

test("auditIntent refuses to return an id when the log is unwritable", () => {
  // The gate is inside the intent write on purpose: a caller cannot get a
  // correlation id, and therefore cannot proceed to the effect, without
  // the log having proved itself first.
  const root = tempRoot();
  mkdirSync(join(root, "var", "logs"), { recursive: true });
  mkdirSync(logFile(root));
  const audit = createAuditLog(root);
  assert.throws(
    () => audit.auditIntent({ action: "delete", resourceId: "r1" }),
    AuditUnavailableError
  );
});

test("intent is written before outcome and the two share a correlation id", () => {
  const root = tempRoot();
  let ticks = 0;
  const audit = createAuditLog(root, {
    now: () => new Date(1700000000000 + ticks++ * 1000),
    newId: () => "corr-1",
  });
  const id = audit.auditIntent({ action: "send", resourceId: "msg-9", payload: { to: "a@b.c" } });
  const outcome = audit.auditOutcome(id, { status: "ok", detail: "delivered" });
  assert.equal(outcome.ok, true);

  const records = readRecords(logFile(root));
  assert.equal(records.length, 2);
  // Order on disk is the assertion that matters: the record proving the
  // server was about to act must already exist before the effect ran.
  assert.equal(records[0].phase, "intent");
  assert.equal(records[1].phase, "outcome");
  assert.equal(records[0].id, id);
  assert.equal(records[1].id, id);
  assert.equal(records[0].action, "send");
  assert.equal(records[0].resourceId, "msg-9");
  assert.equal(records[1].status, "ok");
  // The intent timestamp is the earlier one, so a reader who sorts by time
  // reconstructs the same order the file has.
  assert.ok(records[0].ts < records[1].ts);
});

test("an intent with no outcome is visible in the log", () => {
  // This is the incident signal, not a defect: "the server was about to do
  // X to Y and we do not know whether it finished" is a question an
  // operator can go and answer. A single after-the-fact record would have
  // left nothing behind at all.
  const root = tempRoot();
  const audit = createAuditLog(root, { newId: () => "orphan-1" });
  const id = audit.auditIntent({ action: "charge", resourceId: "acct-7", payload: { cents: 100 } });

  const records = readRecords(logFile(root));
  const forId = records.filter((r) => r.id === id);
  assert.equal(forId.length, 1);
  assert.equal(forId[0].phase, "intent");
  assert.equal(records.some((r) => r.phase === "outcome"), false);
});

test("the payload never reaches the log, only its hash", () => {
  const root = tempRoot();
  const audit = createAuditLog(root);
  // Two synthetic credential shapes: one the util.mjs redaction patterns
  // recognize, and one they do not. Both must be absent, because the
  // defense is the hash, with redaction only as the layer beneath it.
  const secret = "Bearer sk-live-9f8e7d6c5b4a3210";
  const unpatterned = "hunter2-correct-horse-battery-staple";
  const id = audit.auditIntent({
    action: "rotate",
    resourceId: "key-3",
    payload: { authorization: secret, password: unpatterned },
  });
  audit.auditOutcome(id, { status: "ok", detail: `responded with ${secret}` });

  const raw = readFileSync(logFile(root), "utf8");
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes(unpatterned), false);
  assert.equal(raw.includes("sk-live"), false);

  const records = readRecords(logFile(root));
  assert.match(records[0].payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal("payload" in records[0], false);
});

test("the same payload hashes the same regardless of key order", () => {
  // Replay detection is the reason the digest is canonicalized. Two call
  // sites building the same body with their keys in a different order must
  // not look like two different actions.
  const rootA = tempRoot();
  const rootB = tempRoot();
  const a = createAuditLog(rootA);
  const b = createAuditLog(rootB);
  a.auditIntent({ action: "put", resourceId: "x", payload: { alpha: 1, beta: { c: 2, d: 3 } } });
  b.auditIntent({ action: "put", resourceId: "x", payload: { beta: { d: 3, c: 2 }, alpha: 1 } });
  assert.equal(
    readRecords(logFile(rootA))[0].payloadSha256,
    readRecords(logFile(rootB))[0].payloadSha256
  );
});

test("nested metadata is dropped rather than written through", () => {
  const root = tempRoot();
  const audit = createAuditLog(root);
  audit.auditIntent({
    action: "sync",
    resourceId: "r-1",
    meta: { attempt: 2, dryRun: true, note: "manual", body: { secret: "leaked-value" } },
  });
  const record = readRecords(logFile(root))[0];
  assert.deepEqual(record.meta, { attempt: 2, dryRun: true, note: "manual" });
  assert.equal(readFileSync(logFile(root), "utf8").includes("leaked-value"), false);
});

test("writability is re-probed after the ttl so a mid-run change is noticed", () => {
  const root = tempRoot();
  let clockMs = 1700000000000;
  const audit = createAuditLog(root, { now: () => new Date(clockMs), ttlMs: 5000 });
  assert.equal(audit.auditWritable().ok, true);

  // Break the log the way an ACL change or a remount would, after the
  // first probe already succeeded.
  rmSync(logFile(root));
  mkdirSync(logFile(root));

  // Inside the ttl the memoized answer still stands, which is the point of
  // memoizing at all.
  clockMs += 4000;
  assert.equal(audit.auditWritable().ok, true);

  // Past the ttl the probe runs again and catches it. A once-per-process
  // memo would have kept returning true for the life of the server.
  clockMs += 2000;
  assert.equal(audit.auditWritable().ok, false);
});

test("auditOutcome reports a write failure instead of throwing", () => {
  // The effect has already happened by the time an outcome is written.
  // Throwing here would look to the caller like the action failed, and a
  // caller that rolls back a completed write does real damage.
  const root = tempRoot();
  const audit = createAuditLog(root, { newId: () => "late-1" });
  const id = audit.auditIntent({ action: "write", resourceId: "r-1" });
  rmSync(logFile(root));
  mkdirSync(logFile(root));
  let result;
  assert.doesNotThrow(() => {
    result = audit.auditOutcome(id, { status: "ok" });
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});

test("rotation keeps the configured number of files and never loses the record being written", () => {
  const root = tempRoot();
  let n = 0;
  const audit = createAuditLog(root, {
    newId: () => `id-${n++}`,
    maxBytes: 500,
    keep: 2,
  });
  const total = 12;
  for (let i = 0; i < total; i++) {
    audit.auditIntent({ action: "write", resourceId: `r-${i}`, payload: { i } });
  }

  const live = logFile(root);
  assert.ok(existsSync(live));
  assert.ok(existsSync(`${live}.1`));
  assert.ok(existsSync(`${live}.2`));
  // keep is the number of ARCHIVES, so a third archive must never appear.
  assert.equal(existsSync(`${live}.3`), false);

  // The record that triggered the rotation is the one most at risk of
  // being renamed out from under its own write, so it is asserted by name
  // in the live file.
  const liveIds = readRecords(live).map((r) => r.id);
  assert.ok(liveIds.includes(`id-${total - 1}`));

  // Nothing inside the retention window is missing: the ids still on disk
  // must be an unbroken run ending at the last record written.
  const kept = [live, `${live}.1`, `${live}.2`]
    .flatMap((f) => readRecords(f))
    .map((r) => Number(r.id.slice(3)))
    .sort((a, b) => a - b);
  assert.equal(kept[kept.length - 1], total - 1);
  for (let i = 1; i < kept.length; i++) {
    assert.equal(kept[i], kept[i - 1] + 1);
  }
});
