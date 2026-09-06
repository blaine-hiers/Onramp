import { test } from "node:test";
import assert from "node:assert/strict";

import { validateArgs, formatErrors } from "../src/core/validate.mjs";
import { listToolSchemas } from "../src/core/registry.mjs";

// One schema reused across the type and path tests, shaped like a real
// tool schema rather than a minimal one so the nesting is exercised.
const SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1, maxLength: 10 },
    count: { type: "integer", minimum: 1, maximum: 5 },
    mode: { type: "string", enum: ["fast", "slow"] },
    loud: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    filters: {
      type: "object",
      properties: { since: { type: "string" } }
    }
  },
  required: ["message"]
};

const reasons = (result) => result.errors.map((e) => e.reason).join(" | ");
const paths = (result) => result.errors.map((e) => e.path);

test("a conforming object validates with no errors", () => {
  const result = validateArgs(SCHEMA, {
    message: "hi",
    count: 3,
    mode: "fast",
    loud: true,
    tags: ["a", "b"],
    filters: { since: "2026-01-01" }
  });
  assert.equal(result.ok, true, reasons(result));
  assert.deepEqual(result.errors, []);
});

test("a missing required property is reported at that property's own path", () => {
  const result = validateArgs(SCHEMA, { count: 2 });
  assert.equal(result.ok, false);
  assert.deepEqual(paths(result), ["message"]);
  assert.match(result.errors[0].reason, /required/);
});

test("absent arguments are treated as an empty object, not as a root type error", () => {
  // A model that sends no arguments should be told which property it
  // owes, not that the envelope was the wrong shape.
  for (const args of [undefined, null, {}]) {
    const result = validateArgs(SCHEMA, args);
    assert.deepEqual(paths(result), ["message"], `failed for ${String(args)}`);
  }
});

test("an optional property that was left out is not an error", () => {
  const result = validateArgs(SCHEMA, { message: "hi" });
  assert.equal(result.ok, true, reasons(result));
});

test("a wrong scalar type names both what was expected and what arrived", () => {
  const result = validateArgs(SCHEMA, { message: 3 });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /expected string/);
  assert.match(result.errors[0].reason, /received number/);
});

test("a stringly boolean is reported rather than coerced", () => {
  // The trap: src/core/util.mjs's asBool exists precisely because models
  // send "true" for a boolean. This validator does NOT quietly apply it.
  // Silent coercion would hide the schema drift and teach the model
  // nothing. A tool that wants the string form declares a union type.
  const result = validateArgs(SCHEMA, { message: "hi", loud: "true" });
  assert.equal(result.ok, false, "\"true\" must not pass as a boolean");
  assert.deepEqual(paths(result), ["loud"]);
});

test("a union type accepts either member", () => {
  const schema = { type: "object", properties: { loud: { type: ["boolean", "string"] } } };
  assert.equal(validateArgs(schema, { loud: "true" }).ok, true);
  assert.equal(validateArgs(schema, { loud: false }).ok, true);
  assert.equal(validateArgs(schema, { loud: 1 }).ok, false);
});

test("integer rejects a fractional number and number rejects NaN", () => {
  assert.equal(validateArgs(SCHEMA, { message: "hi", count: 2.5 }).ok, false);
  const nan = validateArgs(
    { type: "object", properties: { n: { type: "number" } } },
    { n: NaN }
  );
  assert.equal(nan.ok, false, "NaN passing a minimum check is a bug three files away");
});

test("an array value does not satisfy type object", () => {
  const result = validateArgs(SCHEMA, { message: "hi", filters: [] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /received array/);
});

test("enum membership is enforced against the declared list", () => {
  const result = validateArgs(SCHEMA, { message: "hi", mode: "medium" });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /must be one of/);
  assert.match(result.errors[0].reason, /"fast"/);
});

test("minimum and maximum are inclusive bounds", () => {
  assert.equal(validateArgs(SCHEMA, { message: "hi", count: 1 }).ok, true);
  assert.equal(validateArgs(SCHEMA, { message: "hi", count: 5 }).ok, true);
  assert.equal(validateArgs(SCHEMA, { message: "hi", count: 0 }).ok, false);
  assert.equal(validateArgs(SCHEMA, { message: "hi", count: 6 }).ok, false);
});

test("minLength and maxLength apply to strings", () => {
  assert.equal(validateArgs(SCHEMA, { message: "" }).ok, false);
  assert.equal(validateArgs(SCHEMA, { message: "0123456789" }).ok, true);
  const long = validateArgs(SCHEMA, { message: "01234567890" });
  assert.equal(long.ok, false);
  assert.match(long.errors[0].reason, /at most 10 characters/);
});

test("a value that failed its type check is not then measured", () => {
  // "expected string, received number" plus "below the minimum length"
  // describes one mistake twice, and the second half is nonsense.
  const result = validateArgs(SCHEMA, { message: 3 });
  assert.equal(result.errors.length, 1, reasons(result));
});

test("a bad array element is reported with a bracketed index path", () => {
  const result = validateArgs(SCHEMA, { message: "hi", tags: ["a", 2, "c"] });
  assert.deepEqual(paths(result), ["tags[1]"]);
});

test("a nested object property is reported with a dotted path", () => {
  const result = validateArgs(SCHEMA, { message: "hi", filters: { since: 20260101 } });
  assert.deepEqual(paths(result), ["filters.since"]);
});

test("every problem is collected, not just the first", () => {
  const result = validateArgs(SCHEMA, { count: 99, mode: "medium", loud: "yes" });
  assert.equal(result.errors.length, 4, reasons(result));
  assert.deepEqual(paths(result).sort(), ["count", "loud", "message", "mode"]);
});

test("additionalProperties false rejects an undeclared key by name", () => {
  const schema = { ...SCHEMA, additionalProperties: false };
  const result = validateArgs(schema, { message: "hi", mesage: "typo" });
  assert.equal(result.ok, false);
  assert.deepEqual(paths(result), ["mesage"]);
  assert.match(result.errors[0].reason, /unexpected property/);
});

test("additionalProperties false catches a key only Object.prototype declares", () => {
  // Pins the hasOwn check: with `in`, "toString" looks declared by every
  // schema and slips past the strictest setting the schema can express.
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false
  };
  const result = validateArgs(schema, { a: "x", toString: "surprise" });
  assert.equal(result.ok, false);
  assert.deepEqual(paths(result), ["toString"]);
});

test("undeclared keys are allowed when additionalProperties is absent", () => {
  const result = validateArgs(SCHEMA, { message: "hi", whatever: 1 });
  assert.equal(result.ok, true, reasons(result));
});

test("additionalProperties as a schema validates the extra values", () => {
  const schema = {
    type: "object",
    properties: {},
    additionalProperties: { type: "string" }
  };
  assert.equal(validateArgs(schema, { a: "x" }).ok, true);
  assert.deepEqual(paths(validateArgs(schema, { a: 1 })), ["a"]);
});

test("an unsupported keyword is ignored rather than half-honored", () => {
  // pattern, minItems and allOf are documented as unsupported. A value
  // that only violates one of them passes, which is the documented
  // degradation: the check belongs in the handler.
  const schema = {
    type: "object",
    properties: { s: { type: "string", pattern: "^[0-9]+$" } },
    minProperties: 5
  };
  assert.equal(validateArgs(schema, { s: "abc" }).ok, true);
});

test("a missing or malformed schema fails closed instead of passing everything", () => {
  // The gap this module closes is "no enforcement", so the one thing it
  // must never do is report ok for a tool whose schema it cannot read.
  for (const bad of [undefined, null, "object", 42, []]) {
    const result = validateArgs(bad, { anything: true });
    assert.equal(result.ok, false, `schema ${JSON.stringify(bad)} should fail closed`);
    assert.deepEqual(paths(result), ["(root)"]);
  }
});

test("an empty schema object constrains nothing", () => {
  assert.equal(validateArgs({}, { anything: true }).ok, true);
});

test("the validator never throws, even on a self-referential value", () => {
  const cyclic = { message: "hi" };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => validateArgs(SCHEMA, cyclic));
  const weird = { type: "object", properties: { a: { type: 7, items: 3 } } };
  assert.doesNotThrow(() => validateArgs(weird, { a: [1, 2] }));
});

test("the error list is capped so one bad array cannot flood the response", () => {
  const schema = { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } };
  const result = validateArgs(schema, { tags: Array(5000).fill(1) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length <= 26, `got ${result.errors.length} errors`);
  assert.match(reasons(result), /further errors suppressed/);
});

test("formatErrors renders one actionable line and nothing on success", () => {
  assert.equal(formatErrors(validateArgs(SCHEMA, { message: "hi" })), "");
  const text = formatErrors(validateArgs(SCHEMA, { count: 0 }));
  assert.match(text, /message: required property is missing/);
  assert.match(text, /count: must be >= 1/);
});

test("the registered echo tool's own schema is enforceable as written", () => {
  // The concrete gap: the low-level SDK Server validates the JSON-RPC
  // envelope only, so required: ["message"] is documentation until
  // something calls validateArgs with it.
  const echo = listToolSchemas("all").find((s) => s.name === "echo");
  assert.ok(echo, "echo tool should be registered");
  assert.equal(validateArgs(echo.inputSchema, { message: "hello" }).ok, true);
  const missing = validateArgs(echo.inputSchema, {});
  assert.equal(missing.ok, false, "an argument-less echo call must be rejected");
  assert.deepEqual(paths(missing), ["message"]);
});
