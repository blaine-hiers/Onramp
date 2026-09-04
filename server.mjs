/**
 * =========================================================================
 * <SERVER_NAME> MCP SERVER  (stdio transport)
 * =========================================================================
 * Thin wiring layer: sets up the MCP JSON-RPC handlers and dispatches tool
 * calls to the registry in src/core/registry.mjs. Everything domain-specific
 * lives under src/ - this file should stay small.
 *
 * IMPORTANT: stdout is the MCP JSON-RPC channel. Anything written to
 * stdout that isn't a protocol message corrupts the stream. All
 * human-facing logging goes to stderr (`console.error`).
 */

import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { errDetail } from "./src/core/util.mjs";
import { errorResponse } from "./src/core/respond.mjs";
import { listToolSchemas, getHandler } from "./src/core/registry.mjs";

// Load .env next to this file, regardless of the cwd the MCP client
// launches us from. `quiet: true` because dotenv v17 prints a banner to
// stdout by default, which would corrupt the MCP stream. No .env is
// required for the template to run - MCP_SERVER_NAME/MCP_TOOLSET both
// have safe defaults.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env"), quiet: true });

const SERVER_NAME = process.env.MCP_SERVER_NAME?.trim() || "<SERVER_NAME>";
const log = (...args) => console.error(`[${SERVER_NAME}]`, ...args);

/* =========================================================================
 * MCP SERVER + DISPATCH
 * ========================================================================= */

const server = new Server(
  { name: SERVER_NAME, version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Which toolset this process exposes. See src/core/registry.mjs - every
// tool's `category` doubles as the MCP_TOOLSET filter value. "all"
// (default) exposes everything; a specific category value restricts the
// list, which lets one server file back several differently-scoped MCP
// client entries sharing the same process/sign-in.
// .trim() because on Windows, `set MCP_TOOLSET=x && ...` bakes a trailing
// space into the env var; without trim, filtering silently returns 0 tools.
const TOOLSET = (process.env.MCP_TOOLSET || "all").trim().toLowerCase();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: listToolSchemas(TOOLSET)
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const handler = getHandler(name);
  if (!handler) return errorResponse(`Unknown tool: ${name}`);

  try {
    // `ctx` is how a handler reaches shared, per-process resources (an API
    // client, a token cache, a DB pool, ...) without importing them
    // directly - see src/integrations/README.md. It's empty in the
    // template; build real resources above this handler and add them here
    // as your integrations need them.
    const ctx = {};
    return await handler(args, ctx);
  } catch (err) {
    const detail = errDetail(err); // redacts an Authorization header if present
    log("Tool call failed:", detail);
    return errorResponse(`Tool '${name}' failed: ${detail}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

log(`${SERVER_NAME} MCP running (stdio). Toolset: ${TOOLSET}.`);
