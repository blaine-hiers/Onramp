# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working on
`<SERVER_NAME>`, <PURPOSE>.

## What this is

An opinionated, safety-first **Model Context Protocol** server (stdio
transport) built from `onramp`. It registers tools an MCP client (LM Studio,
Claude Desktop, etc.) can call, and it gates them: every call is validated
against its declared schema, classified by outward effect, run through an
ordered gate, and recorded before and after the effect. Replace this
paragraph with what `<SERVER_NAME>` does once real integrations exist.

Node.js **ESM only**. Every source file is `.mjs`; `package.json` declares
`"type": "commonjs"`, so the `.mjs` extension is what makes ESM work. Never
rename a file to `.js`.

Several core modules are the corrected second implementation of a pattern a
production system got subtly wrong, and each header names the mistake.
**Read that header before moving anything in the file**: those comments are
why the code is shaped this way, and the tests assert the shape.

## Commands

```bash
npm install
npm run env-sync   # render .env from Doppler (source of truth); --diff compares only
npm start          # node server.mjs, normally launched BY the MCP client
npm test           # node --test with the test bootstrap (see Testing)
```

Single file or single test. The `--import` bootstrap is mandatory:

```bash
node --test --import ./scripts/setup-test-env.mjs test/confirm.test.mjs
node --test --import ./scripts/setup-test-env.mjs --test-name-pattern "echo" test/
```

## Architecture

**`server.mjs` is a thin wiring layer and must stay that way.** It sets up
the MCP JSON-RPC handlers and makes one `dispatch()` call. Logic added there
is logic a tool can be written to bypass.

`README.md` carries the file map; the rules below say why each file is
shaped the way it is. The pipeline, all of it in `src/core/dispatch.mjs`:

```
lookup -> validate -> gate -> audit intent -> run -> audit outcome
```

One function rather than a convention each tool author follows, because a
convention is a thing an author forgets. Validation runs **before** the
gate: untrusted arguments must not feed an authorization decision, and a
malformed request needs the schema error, not a denial about a missing
approval that sends the caller looking in the wrong place.

### Tool registration

Each tool file exports `tools: [{ schema, handler, category, effect }]`,
plus an optional `resourceId(args)` when the target is not a plain
`resource_id` argument. `src/core/registry.mjs` concatenates them and throws
**at import** on a duplicate name or a missing effect class. **Adding a tool
means appending one entry to a tool file's array**; there is no dispatch
table to keep in sync, because the schema IS the wiring. A new integration
needs one `import` line in the registry. See `src/integrations/README.md`.

`category` doubles as the `MCP_TOOLSET` filter value (default `all`), so one
server file can back several MCP client entries and each surface toggles
independently.

### The `ctx` object

Handlers receive `(args, ctx)`. `ctx` is how a handler reaches a shared API
client, token cache or DB pool without importing it directly: build the
resource once in `server.mjs` and attach it there. Empty in the template.

## Hard rules

- **stdout is the MCP JSON-RPC channel.** Anything else written there
  corrupts the stream and the client drops the connection with no useful
  error. Human-facing logging goes to stderr via `console.error`. This is
  why `dotenv` is loaded with `quiet: true`.
- **Every tool record declares `effect`: `"read"`, `"write"` or
  `"irreversible"`.** The registry refuses to start without it, because an
  undeclared tool would be refused at the gate one call at a time, forever,
  and the author would debug the gate instead of the record.
- **The effect axis is OUTWARD effect only.** A tool keeping a cache, a
  cursor or a minted approval in `var/state/` is still a `read`, because
  none of it is visible outside this process. The first version of this
  template classified the token-minting half of a two-phase pair as a write,
  which put it behind the dry-run gate and made the safe path impossible to
  exercise until the operator switched the safety off. A taxonomy that makes
  the safe path unusable gets switched off entirely.
- **Never gate an irreversible action on a `confirm: true` argument.** The
  flag is supplied by the model and the model is the thing being gated; a
  model that ingested untrusted content earlier in the session sets it as
  readily as any other argument. Use the two-phase pattern in
  `src/integrations/example/confirm-example.mjs`: a `read` prepare tool
  minting a server-side token bound to a hash of the exact commit payload,
  and an `irreversible` commit tool whose token the gate validates and
  spends.
- **A commit handler never re-checks its own token.** By the time it runs
  the dispatcher has validated the token, confirmed the log is writable,
  spent the token and written the intent record. A second check is a second
  chance to get the check wrong, and the two implementations will drift.
- **The audit record for an effect is written BEFORE the effect, not
  after.** A record written afterwards is lost permanently if the process
  dies in between, and on an idempotency-marked path it is never backfilled:
  the effect is real and there is no evidence it happened. Two records, an
  intent and an outcome, correlated by id. **A dangling intent is not a bug,
  it is the product**: it says the server was about to do X to Y and nobody
  knows whether it finished, which an operator can go and answer. A missing
  single record is indistinguishable from nothing having happened.
- **Never probe writability by opening a file.** On Windows
  `fs.openSync(<directory>, "a")` succeeds and only the first byte fails
  with `EISDIR`, so an open-only probe reports a healthy log right up to the
  moment the first record is dropped. `src/core/audit.mjs` writes a real
  probe file and unlinks it. Permission bits lie the same way: they say
  nothing about ENOSPC, EROFS or an ACL.
- **`src/core/config.mjs` is the only module that reads `process.env`.**
  Everything else imports the frozen `CONFIG` snapshot. Env values are
  stringly typed and arrive from three unrelated places (a shell, an MCP
  client launch config, a container), so a second reader means a second
  coercion, and sooner or later one of them reads a blank as `false` and
  opens a gate that was closed. Values are `.trim()`ed there too: on Windows
  `set MCP_TOOLSET=x && node ...` bakes a trailing space into the value, and
  without the trim the toolset filter matches zero tools.
- **Fail closed, everywhere.** An unparseable config value takes the in-code
  default and the defaults are the safe setting; a corrupt token store
  yields zero valid tokens; a token whose record did not reach disk comes
  back as `""`. The one deliberate exception is audit rotation, which fails
  open and appends anyway, because an oversized log is an operations problem
  and a dropped record is the permanent loss the module exists to prevent.
- Read tools end with `respond(text, args, hint)`; write actions use
  `textResponse`; failures use `errorResponse` (sets `isError`). Do not
  open-code `{ content: [{ type: "text", ... }] }`, or the dispatcher's
  outcome record cannot tell success from failure.
- `errDetail()` (`src/core/util.mjs`) redacts an `Authorization` header out
  of axios-shaped error bodies. Use it instead of raw `err.message` when
  logging an API failure, so an echoed 401 cannot leak a bearer token. It is
  also the only redaction door `src/core/audit.mjs` uses: one implementation
  reached awkwardly beats two that agree only today.

## Dry run

`MCP_DRY_RUN` **defaults to `true`**, so a freshly cloned server cannot
reach the outside world before someone decides it should. In dry run the
pipeline still looks the tool up, validates, gates, checks any confirm token
and writes both audit records; it stops before the handler and it **does not
consume the token**. Previewing must never burn an approval, or operators
learn to skip previewing and the two-phase gate becomes theatre.

Do not add a per-tool override for dry run. A flag a tool sets for itself is
a flag the safe default no longer covers.

## Limitations to state, never to soften

Repeat these in any doc or tool description that describes the safety layer.
A template that ships strong defaults with an honest limitations section
gets trusted; the same defaults with marketing language get an adopter hurt.

- The confirm token gates **what** is sent, not **who** decided to send it.
  The model still chooses when to spend a token it holds, and a token minted
  during a poisoned turn can be spent in that same turn. Closing that gap
  needs an out-of-band human approval channel, which a stdio server cannot
  reach. **Never describe this as human-in-the-loop approval.**
- Roles here are structural (which surface a call arrived on, via
  `MCP_TOOLSET`), not identity-based. There is no login, no session and no
  user, so nothing in this server can answer "who asked".
- `src/core/validate.mjs` implements a documented subset of JSON Schema, not
  JSON Schema. Supported: `type` (including a union array), `required`,
  `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `items`,
  `properties`, `additionalProperties`. Everything else is silently ignored,
  and its header lists what. A constraint outside that list belongs in the
  handler, where the failure can be explained in the tool's own terms.
- Reads are ungated by design: no dry run, no audit record, no approval, and
  that holds only while `read` keeps meaning what the effect axis says.

## Runtime layout

All runtime output (state, logs, dated reports) lives under `var/`
(`var/state/`, `var/logs/`, `var/reports/`), resolved through
`src/core/paths.mjs`'s `statePath()` / `logPath()` / `reportPath()`. The
confirm store is `var/state/confirm-tokens.json`; the audit log is
`var/logs/audit.jsonl` with size-rotated archives. Subdirectories are created
lazily, and a same-named legacy file at the repo root migrates into `var/` on
first resolution. Resolve paths lazily in new modules too: doing it at import
moves a directory-creation failure to load time, where it takes the process
down before anything can report it. `.env` is config, not runtime output, and
stays at the repo root (gitignored).

## Env sync

`.env` is **generated** by `npm run env-sync` from Doppler (dev scope only;
see `.env.example` for the schema, names only). Never hand-edit or commit
`.env`. Adding a new var: declare its name in `.env.example`, give it a value
in Doppler, run `npm run env-sync`, then read it in `src/core/config.mjs` and
nowhere else.

## Docker

`Dockerfile` and `docker-compose.yml` make the server container-ready:
**`var/` is the only volume that carries state**, and `.env` is mounted
read-only. Run the stdio entry point (`npm start`) **natively** from the MCP
client on the host, because an MCP client does not talk to a container over
stdio; the container is for a standalone worker alongside the server (a
polling job, a scheduled script).

## Testing conventions

`node --test` with everything mocked: no network, no live calls in the
example suites. `scripts/setup-test-env.mjs` is loaded via `--import` so any
module that resolves a stateful path from an env var **once at module load**
can be redirected to a per-pid scratch path before the suite imports it; see
that file's header for the pattern. It sits outside `test/` so `node --test`
does not discover it as an empty suite.

The confirm store, the audit log and the path helpers take injected clocks,
roots and id sources (`createConfirmStore`, `createAuditLog`,
`createPaths`). Use them rather than sleeping or writing into the repo: a
test that sleeps for a TTL is a test someone deletes. Tests assert on
`deniedAt` step names on purpose, so reordering the gate breaks a test
instead of silently changing what the server permits.
