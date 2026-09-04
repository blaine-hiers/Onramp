/**
 * =========================================================================
 * TOOL REGISTRY
 * =========================================================================
 * The single place every MCP tool is enumerated. Each tool file exports
 * `tools`, an array of `{ schema, handler, category }` records; this
 * module concatenates them and offers lookup helpers.
 *
 * Adding a new tool = ONE change (append to a tool file's array).
 * Adding a new toolset = ONE change (import the file here).
 *
 * WHY the dispatch table pattern (vs a big `if (name === ...)` chain in
 * server.mjs): every tool now co-locates its schema with the handler
 * that fulfills it, so "added a tool, forgot to wire it up" bugs are
 * impossible - the schema IS the wiring.
 */

import { tools as exampleTools } from "../integrations/example/example-tool.mjs";
import { tools as systemTools } from "../system/health.mjs";

const ALL = [
  ...exampleTools,
  ...systemTools
];

// Fail fast if two tools declare the same name (would silently overwrite
// each other in the dispatch map).
{
  const seen = new Set();
  for (const t of ALL) {
    if (seen.has(t.schema.name)) {
      throw new Error(`Duplicate tool name in registry: ${t.schema.name}`);
    }
    seen.add(t.schema.name);
  }
}

/**
 * All tool schemas, filtered by MCP_TOOLSET.
 * "all" (default) returns everything; a specific value (e.g. "example")
 * returns only tools with that category.
 */
export function listToolSchemas(toolset = "all") {
  // .trim() defensively - callers may pass through an env var that on
  // Windows can carry trailing whitespace from `set X=y && ...`.
  const t = String(toolset).trim().toLowerCase();
  return ALL
    .filter((tool) => t === "all" || tool.category === t)
    .map((tool) => tool.schema);
}

/**
 * O(1) name -> handler lookup for the dispatch step. Built once at
 * module load; ALL is frozen so the dispatch table can't be mutated at
 * runtime.
 */
Object.freeze(ALL);
const HANDLERS = new Map(ALL.map((t) => [t.schema.name, t.handler]));

export function getHandler(name) {
  return HANDLERS.get(name);
}

/** Category of a tool by name; useful for auth-scoping in the dispatcher. */
const CATEGORIES = new Map(ALL.map((t) => [t.schema.name, t.category]));
export function getCategory(name) {
  return CATEGORIES.get(name);
}
