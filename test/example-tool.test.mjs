import { test } from "node:test";
import assert from "node:assert/strict";

import { tools } from "../src/integrations/example/example-tool.mjs";

test("example tool exports the registry shape", () => {
  assert.equal(tools.length, 1);
  const [echo] = tools;
  assert.equal(echo.category, "example");
  assert.equal(echo.schema.name, "echo");
  assert.equal(typeof echo.handler, "function");
  assert.deepEqual(echo.schema.inputSchema.required, ["message"]);
});

test("echo handler returns the message prefixed and wrapped in MCP content", async () => {
  const [echo] = tools;
  const result = await echo.handler({ message: "hello" });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, "echo: hello");
});

test("echo handler coerces a missing message to an empty string rather than throwing", async () => {
  const [echo] = tools;
  const result = await echo.handler({});
  assert.equal(result.content[0].text, "echo: ");
});

test("echo handler honors no_hint (respond() contract)", async () => {
  const [echo] = tools;
  const result = await echo.handler({ message: "x", no_hint: true });
  assert.equal(result.content[0].text, "echo: x");
});
