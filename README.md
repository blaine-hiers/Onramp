# Onramp

An opinionated, safety-first Model Context Protocol server over stdio, in
Node.js. Clone it, add your tools, ship.

Most MCP scaffolds are a transport plus a tool list. This one also ships the
layer that decides whether a call should happen: a tool registry whose
schema is the wiring, enforced input validation, an ordered effect gate, a
dry-run default, an append-only audit log with a no-audit-no-action
precondition, and a two-phase confirm-token handshake for irreversible
actions. Several are the corrected second implementation of a pattern a
production system got subtly wrong, and each module header names the mistake
it corrects.

## Quick start

```bash
npm install
npm test          # node --test
npm start         # runs the stdio server; normally launched BY an MCP client
```

No edits required. Point your MCP client (LM Studio, Claude Desktop, ...) at
`node server.mjs` here and it lists `echo`, `health_check`,
`example_prepare_delete` and `example_delete`.

**`MCP_DRY_RUN` defaults to `true`.** A fresh clone, run before anyone reads
the docs, must not be able to send a message or destroy a record, so live
mode is an explicit act: `MCP_DRY_RUN=false`.

## Making this your own

1. Replace `<SERVER_NAME>` / `<PURPOSE>` in `CLAUDE.md`, `server.mjs` and
   this README's title, and `package.json`'s `name`/`description`.
2. Add tools under `src/integrations/<your-integration>/` (see
   `src/integrations/README.md`), wire each file into
   `src/core/registry.mjs` with one `import` line, and declare an `effect`
   on every record.
3. Delete `src/integrations/example/` and its tests.
4. For shared config or secrets, set `MCP_SERVER_NAME` in Doppler and run
   `npm run env-sync`; declare any new variable's **name** in `.env.example`
   first (see `scripts/env-sync.mjs`).

## Effect classes and the gate

Every tool declares one of three classes, and the axis is outward effect
only:

```
read          reaches nothing outside the process; may keep local state
write         reaches outside, but can be undone or repeated without harm
irreversible  cannot be taken back: mail sent, a payment moved, a record
              destroyed. The only class that requires a confirm token
```

**A tool that keeps its own state in `var/` is still a read.** The first
version of this template classified the token-minting half of a two-phase
pair as a write, which put it behind the dry-run gate: a fresh clone could
never mint an approval, so the safe path could not be exercised until the
operator switched off the very safety that made it interesting, and a
taxonomy that makes the safe path unusable gets switched off entirely.

`src/core/effect.mjs` runs one ordered decision per call, and a denial
reports `deniedAt` naming the step that produced it:

```
class           the tool declared a known effect class
mode            dry run or live; never a denial, it selects the path
accountability  the audit log is provably writable (live non-reads only)
approval        a valid, unconsumed, correctly bound confirm token, for
                the irreversible class only
```

That is the difference between a caller learning the log is unwritable and a
caller learning it needs a token; one boolean would tell it neither. Reads
stop at step one, ungated and out loud: an undocumented ungated path is a
problem, a documented one is a decision.

## The pipeline

`src/core/dispatch.mjs` routes every call through one function, because a
convention each tool author has to remember is a convention one of them
forgets:

```
lookup -> validate -> gate -> audit intent -> run -> audit outcome
```

Validation runs **before** the gate: untrusted arguments must not feed an
authorization decision, and a malformed request deserves the schema error
rather than a confusing denial about a missing approval.

**Logging the audit record after the write loses it**, permanently, if the
process dies between the two, and on an idempotency-marked path it is never
backfilled: the effect is real and there is no evidence it happened. So
`src/core/audit.mjs` writes an intent before and an outcome after,
correlated by id. An intent with no outcome is not a bug, it is the incident
signal: something was about to happen and nobody knows whether it finished.

**A writability probe that only opens the file lies on Windows**, where
`fs.openSync(<directory>, "a")` succeeds and only the first written byte
fails with `EISDIR`, so an open-only check reports a healthy log until the
first record is dropped. The probe writes a real file and unlinks it.

## Two-phase confirmation

**`confirm: true` as a tool argument is broken.** The flag is supplied by
the model, and the model is the thing being gated: a model that ingested
untrusted content earlier in the session sets it as readily as any other
argument. It is not a confirmation, it is a parameter with a reassuring
name.

So the server mints the approval.
`src/integrations/example/confirm-example.mjs` is the copyable pattern:

```bash
# Phase 1: read the target, preview it, mint a single-use token bound to a
# hash of the exact commit payload. effect "read", so it runs in dry run.
example_prepare_delete  { "resource_id": "rec-1" }

# Phase 2: spend it. effect "irreversible", so the gate validates and
# consumes the token before the handler is entered.
example_delete          { "resource_id": "rec-1", "confirm_token": "..." }
```

256 bits of entropy (unforgeable), single use (no replay), TTL bounded (not
a standing permission), bound to the resource id and a hash of the payload
(no swapping the approved payload for another). **A commit handler must
never re-check the token**: the dispatcher has already validated it, checked
the log, spent it and written the intent, and a second check is a second
chance to get it wrong.

## Limitations

Read these before trusting the layer above with anything that matters.

- The confirm token gates **what** is sent, not **who** decided to send it.
  The model still chooses when to spend a token it holds, and a token minted
  during a poisoned turn can be spent in that same turn. What it buys is
  that the bytes someone approved are the bytes that ship. Closing the rest
  needs an out-of-band human approval channel, which a stdio server cannot
  reach. This is not human-in-the-loop approval.
- Roles are structural, not identity-based. `MCP_TOOLSET` selects which
  surface a call arrived on, and that is the whole of the scoping. There is
  no login, no session, no user, and nothing here can answer "who asked".
- `src/core/validate.mjs` covers a documented subset of JSON Schema: `type`
  (including a union array), `required`, `enum`, `minimum`, `maximum`,
  `minLength`, `maxLength`, `items`, `properties`, `additionalProperties`.
  `$ref`, the `allOf`/`anyOf`/`oneOf` combinators, `pattern`, `format`,
  `const`, `minItems`/`maxItems`, `uniqueItems`, `multipleOf`, the exclusive
  bounds, tuple `items` and `default` are ignored. A constraint outside that
  list belongs in the handler.
- Reads are ungated by design: no dry run, no audit record, no approval. If
  a read can change something outside the process, it was misdeclared.

## Architecture

```
server.mjs                 stdio transport, MCP handlers, one dispatch call
src/core/dispatch.mjs      the pipeline every tool call goes through
src/core/registry.mjs      tool records; the schema IS the wiring
src/core/effect.mjs        effect classes and the ordered gate
src/core/confirm.mjs       server-minted, single-use approval tokens
src/core/audit.mjs         append-only JSONL log, intent plus outcome
src/core/validate.mjs      inputSchema enforcement, no new dependency
src/core/config.mjs        the ONE reader of process.env, frozen at import
src/core/paths.mjs         var/ layout, plus respond/util/emoji helpers
src/integrations/example/  echo plus the two-phase worked example
src/system/                health_check
scripts/                   env-sync + the test bootstrap
test/                      node --test suites
```

Every other module imports the frozen `CONFIG` snapshot instead of reading
`process.env` again, so no gate invents its own coercion and gets it
backwards. Runtime output lives under `var/`: `var/state/` (the confirm
store), `var/logs/` (`audit.jsonl` and its size-rotated archives) and
`var/reports/`. **`var/` is the only volume a container needs.** `.env` is
config, not runtime output, and stays at the repo root (gitignored).
`CLAUDE.md` carries the conventions these files enforce.

## Docker and CI

```bash
docker compose build
docker compose run --rm mcp-server npm start   # sanity-check in the container
```

The stdio entry point is meant to be run **natively** by your MCP client on
the host: MCP-over-stdio needs a direct parent/child process relationship,
which a container boundary breaks. The compose file is for a standalone
worker added later. `.github/workflows/ci.yml` runs `npm ci && npm test` on
every push and pull request against `main`.

## License

MIT. See `LICENSE`.
