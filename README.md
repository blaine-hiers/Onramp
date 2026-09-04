# Onramp

A Model Context Protocol server over stdio, in Node.js, with the boring parts
already done. Clone it, add your tools, ship.

Production-shaped rather than a toy: a tool registry as the dispatch table, a
`var/` runtime layout, name-only env declaration with a sync step, and a
container path for non-stdio workers. No business logic ships with it, just one
example `echo` tool you delete once yours works.

## Quick start

```bash
npm install
npm test          # node --test
npm start         # runs the stdio server; normally launched BY an MCP client
```

No edits required to get the example `echo` tool working end to end. Point
your MCP client (LM Studio, Claude Desktop, ...) at `node server.mjs` in
this directory and it will list one tool: `echo`.

## Making this your own

1. Replace `<SERVER_NAME>` / `<PURPOSE>` in `CLAUDE.md`, `server.mjs` and this
   README's title.
2. Add real tools under `src/integrations/<your-integration>/` — see
   `src/integrations/README.md` for the exact pattern — and wire each new
   file into `src/core/registry.mjs` with one `import` line.
3. Delete `src/integrations/example/` and its test once you have a real
   integration in place.
4. If you need shared config/secrets, set `MCP_SERVER_NAME` in Doppler and
   run `npm run env-sync`; declare any new var's **name** in `.env.example`
   first (see `scripts/env-sync.mjs`).
5. Update `package.json`'s `name`/`description`.

## Architecture

```
server.mjs                 stdio transport, dispatch
src/core/                  registry (dispatch table), respond helpers, paths, util, emoji
src/integrations/example/  the one example tool (delete once you add your own)
src/system/                health_check
scripts/                   env-sync + the test bootstrap
test/                      node --test suites
```

See `CLAUDE.md` for the full set of conventions (stdout discipline, the
`ctx` object, the `var/` runtime layout, testing).

## Docker

```bash
docker compose build
docker compose run --rm mcp-server npm start   # sanity-check inside the container
```

The stdio MCP entry point is meant to be run **natively** by your MCP
client on the host, not inside a container — MCP-over-stdio needs a direct
parent/child process relationship with the client, which a container
boundary breaks. `Dockerfile`/`docker-compose.yml` exist so any standalone
worker or scheduled script you add later (not the stdio server itself) can
run containerized, with `var/` and `.env` volume-mounted in.

## CI

`.github/workflows/ci.yml` runs `npm ci && npm test` on every push and pull
request against `main`.

## License

MIT. See `LICENSE`.
