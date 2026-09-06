/**
 * =========================================================================
 * EXAMPLE TOOL
 * =========================================================================
 * A minimal read tool showing the registry pattern this template is built
 * around: export `tools`, an array of `{ schema, handler, category }`
 * records. `src/core/registry.mjs` concatenates every tool file's array and
 * builds the dispatch table from it - there is no separate list to keep in
 * sync. Adding a tool is appending one entry to an array like this one;
 * adding a new integration is one more `import` line in registry.mjs.
 *
 * Delete this file once you've added your own integration under
 * src/integrations/<your-integration>/ - see src/integrations/README.md.
 */

import { respond } from "../../core/respond.mjs";

const CATEGORY = "example";

export const tools = [
  {
    category: CATEGORY,
    // Echo touches nothing outside the process, so it is a read and the
    // gate lets it straight through. See src/core/effect.mjs.
    effect: "read",
    schema: {
      name: "echo",
      description:
        "Echo back the given message. Demonstrates the tool-registry pattern - replace with your own tools under src/integrations/.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Text to echo back." }
        },
        required: ["message"]
      }
    },
    handler: async (args) => {
      const message = String(args?.message ?? "");
      return respond(`echo: ${message}`, args);
    }
  }
];
