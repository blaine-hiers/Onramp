# Integrations

This directory holds one subdirectory per external system your MCP server
talks to (an API, a database, a local model endpoint, ...). It ships with
only `example/`, which contains a single `echo` tool with no external
dependency. It exists to show the shape every integration follows, not to
be a real integration itself. Delete `example/` once you've added your own.

## The pattern

1. **Create a subdirectory**: `src/integrations/<name>/`.
2. **Export `tools`** from one or more `.mjs` files in it, an array of:
   ```js
   export const tools = [
     {
       category: "<name>",          // also the MCP_TOOLSET filter value
       schema: {
         name: "tool_name",
         description: "...",
         inputSchema: { type: "object", properties: { /* ... */ } }
       },
       handler: async (args, ctx) => {
         // ... do the work ...
         return respond(text, args);   // or textResponse / errorResponse
       }
     }
   ];
   ```
3. **Wire it into `src/core/registry.mjs`**: add one `import { tools as
   xTools } from "../integrations/<name>/....mjs"` line and one spread into
   `ALL`. That's the entire integration point: there is no other list to
   update, and `registry.mjs` throws at import time if two tools collide on
   `schema.name`.
4. If the integration needs a shared client, token cache, or config, build
   it once in `server.mjs` and hand it to handlers via the `ctx` object
   passed as the second handler argument (see the comment in `server.mjs`).
   Handlers should never reach past `ctx` to touch credentials, refresh
   loops, or cache files directly. That keeps every tool testable by
   injecting a fake `ctx`.
5. Use `respond(text, args, hint)` for read tools, `textResponse(text)` for
   write actions, and `errorResponse(text)` for failures (`src/core/
   respond.mjs`), never open-coding the MCP `{ content: [...] }` shape.
6. If your integration writes runtime state, a log, or a dated report, put
   it under `var/` via `src/core/paths.mjs`'s `statePath()` / `logPath()` /
   `reportPath()` rather than the repo root. See that file's header comment.
7. Add a `category` value distinct from `system` and `example` so
   `MCP_TOOLSET=<name>` can expose just this integration's tools (useful when
   one MCP client entry per product family is preferable to one that exposes
   everything).

## What does NOT belong here

No business logic for any specific company, customer, or workflow. This
directory in the shipped template contains only the `example/` pattern
demo. Real integrations, credentials, and domain rules are added by
whoever uses this template, in their own repo.
