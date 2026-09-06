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

import { isEffectClass } from "./effect.mjs";

import { tools as exampleTools } from "../integrations/example/example-tool.mjs";
import { tools as confirmExampleTools } from "../integrations/example/confirm-example.mjs";
import { tools as systemTools } from "../system/health.mjs";

const ALL = [
  ...exampleTools,
  ...confirmExampleTools,
  ...systemTools
];

// Fail fast on the two invariants a tool record must satisfy. Both throw at
// MODULE LOAD rather than at call time, which turns a silent runtime surprise
// into a startup crash the author sees on the first run.
//
// Duplicate name: the later record would silently overwrite the earlier one in
// the dispatch map, and which one wins depends on import order.
//
// Missing effect class: a tool with no declared class would reach the gate and
// be refused there, one call at a time, forever. Refusing to start is kinder
// and it makes the declaration impossible to forget rather than merely
// documented.
{
  const seen = new Set();
  for (const t of ALL) {
    if (seen.has(t.schema.name)) {
      throw new Error(`Duplicate tool name in registry: ${t.schema.name}`);
    }
    seen.add(t.schema.name);

    if (!isEffectClass(t.effect)) {
      throw new Error(
        `Tool '${t.schema.name}' must declare effect: "read", "write" or ` +
          `"irreversible" (got ${JSON.stringify(t.effect)}).`
      );
    }
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

/**
 * The whole tool record by name: schema, handler, category, effect class and
 * any optional `resourceId` resolver.
 *
 * The dispatcher needs all of it at once. Reaching for four separate lookups
 * invites a caller to fetch the handler and skip the effect class, which is
 * the one combination that must never happen.
 */
const TOOLS = new Map(ALL.map((t) => [t.schema.name, t]));
export function getTool(name) {
  return TOOLS.get(name);
}

/** Effect class of a tool by name: "read", "write" or "irreversible". */
export function getEffect(name) {
  return TOOLS.get(name)?.effect;
}
