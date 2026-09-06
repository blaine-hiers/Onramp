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

import { CONFIG } from "./src/core/config.mjs";
import { dispatch } from "./src/core/dispatch.mjs";
import { listToolSchemas } from "./src/core/registry.mjs";

// Load .env next to this file, regardless of the cwd the MCP client
// launches us from. `quiet: true` because dotenv v17 prints a banner to
// stdout by default, which would corrupt the MCP stream. No .env is
// required for the template to run - MCP_SERVER_NAME/MCP_TOOLSET both
// have safe defaults.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env"), quiet: true });

// Config is read in exactly ONE place, src/core/config.mjs, which snapshots
// process.env at import and freezes it. Reading it again here would let the
// server and its subsystems disagree about their own settings.
const SERVER_NAME = CONFIG.SERVER_NAME;
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
// The trailing-whitespace trim that Windows makes necessary now happens in
// config.mjs, alongside every other env coercion.
const TOOLSET = CONFIG.TOOLSET;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: listToolSchemas(TOOLSET)
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  // `ctx` is how a handler reaches shared, per-process resources (an API
  // client, a token cache, a DB pool, ...) without importing them directly -
  // see src/integrations/README.md. It's empty in the template; build real
  // resources above this handler and pass them in here.
  const ctx = {};

  // Everything between here and the handler (schema validation, the ordered
  // effect gate, the audit records) lives in src/core/dispatch.mjs. It is one
  // call rather than inline logic because this file is a wiring layer, and
  // because a pipeline nobody can bypass is the whole point: a tool cannot be
  // added that skips a step an author forgot to copy.
  return await dispatch(name, args, ctx);
});

const transport = new StdioServerTransport();
await server.connect(transport);

// The run mode belongs in the banner: an operator who cannot tell at a
// glance whether this process can cause a real effect will eventually
// assume the wrong one.
log(
  `${SERVER_NAME} MCP running (stdio). Toolset: ${TOOLSET}. ` +
    `Mode: ${CONFIG.DRY_RUN ? "DRY RUN (no outward effects)" : "LIVE"}.`
);
