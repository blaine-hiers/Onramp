/**
 * Test bootstrap - loaded via `node --test --import ./scripts/setup-test-env.mjs`.
 *
 * PATTERN: if a module ever resolves a stateful file path from an env var
 * ONCE at module load time (rather than lazily, per call - an audit log, a
 * token cache, a corpus file, ...), redirect that env var to a per-pid
 * scratch path HERE, before anything imports the module. `--import` is what
 * guarantees that ordering, and Node propagates it to each per-file test
 * child process.
 *
 * Per-pid (not one shared path), because `node --test` runs each test file
 * in its own child process, IN PARALLEL: a shared file makes read-back
 * assertions flaky (one test's write can land between another test's write
 * and its own read) and grows without bound across runs as the OS recycles
 * pids.
 *
 * There is nothing to redirect yet in this template: src/core/paths.mjs's
 * var/state|logs|reports layout is resolved lazily, per call, so its own
 * suite (test/paths.test.mjs) builds a disposable temp root via
 * `createPaths(root)` instead of needing an env override here. This exact
 * hazard is real once a module resolves an env-configured path at import
 * time (an audit log, a token cache, a corpus file) - add a block below
 * the moment that happens, e.g.:
 *
 *   import { tmpdir } from "node:os";
 *   import { join } from "node:path";
 *   import { writeFileSync } from "node:fs";
 *
 *   const EXAMPLE_LOG = join(tmpdir(), `myserver-test-example-${process.pid}.log`);
 *   process.env.EXAMPLE_LOG_PATH = EXAMPLE_LOG;
 *   writeFileSync(EXAMPLE_LOG, "");
 *
 * NOTE: deliberately NOT placed under test/ or named test-*.mjs - both match
 * node --test's default file-discovery globs and would otherwise be picked
 * up and run as an empty suite.
 */
