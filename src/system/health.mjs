/**
 * =========================================================================
 * SYSTEM / DIAGNOSTICS TOOLSET
 * =========================================================================
 * Operational tools that report on the server process itself, rather than
 * a back-end integration. `health_check` gives a one-glance status so you
 * can tell the server is alive without digging through stderr.
 *
 * When you add a real integration (an API client, a database, ...), add its
 * own `{ ok, detail }` check here and fold it into the response - this
 * file is the template's example, not the ceiling.
 */

import { CONFIG } from "../core/config.mjs";
import { respond } from "../core/respond.mjs";
import * as E from "../core/emoji.mjs";

const CATEGORY = "system";

export const tools = [
  {
    category: CATEGORY,
    // Diagnostics only: reports state, changes none of it.
    effect: "read",
    schema: {
      name: "health_check",
      description:
        "Report the health of the server process at a glance: uptime, Node version, memory, active toolset. Read-only and side-effect free.",
      inputSchema: { type: "object", properties: {} }
    },
    handler: async (args) => {
      const mem = process.memoryUsage();
      const toolset = CONFIG.TOOLSET;

      const text = [
        `${E.OK} Health check - process up ${Math.round(process.uptime())}s`,
        "",
        `Node: ${process.version}`,
        `RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
        `Toolset: ${toolset}`
      ].join("\n");

      return respond(text, args);
    }
  }
];
