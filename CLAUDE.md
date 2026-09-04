# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working on
`<SERVER_NAME>` — <PURPOSE>.

## What this is

A local **Model Context Protocol** server (stdio transport) built from
`onramp`. It registers tools an MCP client (LM Studio, Claude
Desktop, etc.) can call. Replace this paragraph with what `<SERVER_NAME>`
actually does once you've added real integrations.

Node.js **ESM only**. Every source file is `.mjs`; `package.json` declares
`"type": "commonjs"`, so the `.mjs` extension is what makes ESM work — never
rename a file to `.js`.

## Commands

```bash
npm install
npm run env-sync   # render .env from Doppler (source of truth); --diff to compare only
npm start          # node server.mjs — normally launched BY the MCP client, not by hand
npm test           # node --test with the test bootstrap (see Testing)
```

Single test file / single test — the `--import` bootstrap is mandatory, not optional:

```bash
node --test --import ./scripts/setup-test-env.mjs test/example-tool.test.mjs
node --test --import ./scripts/setup-test-env.mjs --test-name-pattern "echo" test/
```

## Architecture

**`server.mjs` is a thin wiring layer and must stay that way.** It sets up
the MCP JSON-RPC handlers and dispatches to the registry. All domain logic
lives under `src/`.

```
server.mjs                 stdio transport, dispatch
src/core/                  registry (dispatch table), respond helpers, paths, util, emoji
src/integrations/example/  the one example tool (delete once you add your own)
src/system/                health_check
scripts/                   env-sync + the test bootstrap
```

### Tool registration

Each tool file exports `tools: [{ schema, handler, category }]`.
`src/core/registry.mjs` concatenates them, throws at import time on
duplicate names, and builds a frozen name→handler map. **Adding a tool =
appending one entry to a tool file's array** — there is no dispatch table or
schema list to keep in sync. A new integration needs one extra `import` line
in the registry. See `src/integrations/README.md` for the full pattern.

`category` doubles as the `MCP_TOOLSET` filter value (default `all`) — the
same server file can be registered several times in an MCP client under
different `MCP_TOOLSET` values so each product family toggles independently.

### The `ctx` object

Handlers receive `(args, ctx)`. `ctx` is where you hand a handler a shared
API client, token cache, or DB pool without it importing those directly —
build the resource once in `server.mjs` and attach it to `ctx` there. It's
empty in the template.

## Hard rules

- **stdout is the MCP JSON-RPC channel.** Anything else written there
  corrupts the stream. All human-facing logging goes to stderr via
  `console.error`. This is why `dotenv` is loaded with `quiet: true`.
- Read tools end with `respond(text, args, hint)`; write actions use
  `textResponse`; failures use `errorResponse` (sets `isError`). Don't
  open-code `{ content: [{ type: "text", ... }] }`.
- `errDetail()` (`src/core/util.mjs`) redacts an `Authorization` header out
  of axios-shaped error bodies. Use it instead of raw `err.message` when
  logging an API failure, so an echoed 401 can't leak a bearer token.
- Env vars are `.trim()`ed before use. On Windows, `set MCP_TOOLSET=x &&
  node ...` bakes a trailing space into the value; without trim the toolset
  filter silently matches zero tools.

## Runtime layout

All runtime output — state, logs, dated reports — lives under `var/`
(`var/state/`, `var/logs/`, `var/reports/`), resolved through
`src/core/paths.mjs`'s `statePath()` / `logPath()` / `reportPath()`. Each
subdirectory is created lazily on first use, and a same-named legacy file
sitting at the repo root migrates into `var/` automatically the first time
anything resolves that path. `.env` is config, not runtime output, and stays
at the repo root (gitignored).

## Env sync

`.env` is **generated** by `npm run env-sync` from Doppler (dev scope only —
see `.env.example` for the schema, names only). Never hand-edit or commit
`.env`. Adding a new var: declare its name in `.env.example`, give it a
value in the Doppler dashboard, then `npm run env-sync`.

## Docker

`Dockerfile` + `docker-compose.yml` make the server container-ready:
`var/` and `.env` are volume-mounted. The stdio MCP entry point
(`npm start`) is meant to be run **natively** by the MCP client (LM Studio,
Claude Desktop) on the host — an MCP client does not talk to a container
over stdio. Use the container for anything that runs as a standalone
worker/process alongside the server (a polling job, a scheduled script),
not for the stdio server itself.

## Testing conventions

`node --test` with everything mocked — no network, no live calls in the
example suite. `scripts/setup-test-env.mjs` is loaded via `--import` so any
module that resolves a stateful path from an env var **once at module
load** can be redirected to a per-pid scratch path before the suite imports
it; see that file's header comment for the pattern and when to extend it.
Deliberately kept outside `test/` so `node --test` doesn't discover it as an
empty suite.
