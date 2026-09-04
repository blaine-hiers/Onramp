import { test } from "node:test";
import assert from "node:assert/strict";

import { listToolSchemas, getHandler, getCategory } from "../src/core/registry.mjs";

test("registry exposes tools with unique names and real handlers", () => {
  const all = listToolSchemas("all");
  assert.ok(all.length > 0);

  const names = all.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");

  for (const schema of all) {
    assert.equal(typeof schema.name, "string");
    assert.ok(schema.inputSchema, `${schema.name} missing inputSchema`);
    assert.equal(typeof getHandler(schema.name), "function", `${schema.name} has no handler`);
    assert.equal(typeof getCategory(schema.name), "string");
  }
});

test("listToolSchemas filters by toolset", () => {
  const all = listToolSchemas("all");
  const example = listToolSchemas("example");
  assert.ok(example.length > 0);
  assert.ok(example.length < all.length, "a single toolset should be a subset");
  assert.ok(example.every((s) => getCategory(s.name) === "example"));

  // trailing whitespace / casing is tolerated (Windows env quirk)
  assert.equal(listToolSchemas("  EXAMPLE ").length, example.length);
});

test("unknown tool name resolves to no handler", () => {
  assert.equal(getHandler("definitely_not_a_tool"), undefined);
});
