/**
 * =========================================================================
 * TOOL DISPATCH PIPELINE
 * =========================================================================
 * Everything that happens between "the client asked for a tool" and "the
 * handler ran" lives here, so server.mjs stays the thin wiring layer it is
 * documented to be.
 *
 * The pipeline, in order:
 *
 *   lookup -> validate -> gate -> audit intent -> run -> audit outcome
 *
 * WHY it is a pipeline and not a set of conventions each tool follows: a
 * convention is a thing an author can forget. Routing every call through one
 * function makes it structurally impossible to add a tool that performs an
 * effect without being validated, gated and audited, which is the property
 * the whole safety layer depends on.
 *
 * NOTE on ordering: validation runs BEFORE the gate. Arguments that cannot
 * be trusted should not be used to compute an authorization decision, and a
 * caller that sent a malformed request deserves the schema error rather than
 * a confusing denial about a missing approval.
 */

import { CONFIG } from "./config.mjs";
import { getTool } from "./registry.mjs";
import { validateArgs, formatErrors } from "./validate.mjs";
import { gate, payloadDigest, approvalPayload, resourceIdFor } from "./effect.mjs";
import { auditIntent, auditOutcome } from "./audit.mjs";
import { errorResponse, textResponse } from "./respond.mjs";
import { errDetail } from "./util.mjs";

const log = (...args) => console.error(`[${CONFIG.SERVER_NAME}]`, ...args);

/**
 * Handle one MCP tool call end to end. Always resolves to an MCP response
 * shape, never throws: a thrown error here would surface to the client as a
 * transport fault rather than as a tool result the model can read and react
 * to.
 */
export async function dispatch(name, rawArgs, ctx = {}) {
  const args = rawArgs ?? {};

  const tool = getTool(name);
  if (!tool) return errorResponse(`Unknown tool: ${name}`);

  // 1. Validate against the tool's own declared schema.
  //
  // The low-level SDK Server class validates the JSON-RPC envelope and
  // nothing else, so without this step a declared `required` field is
  // documentation addressed to the model rather than a constraint the
  // server enforces. Handlers still coerce defensively, but they should not
  // have to carry the whole burden.
  const check = validateArgs(tool.schema?.inputSchema, args);
  if (!check.ok) {
    return errorResponse(`Invalid arguments for '${name}': ${formatErrors(check)}`);
  }

  // 2. Run the ordered decision.
  const decision = await gate({ name, tool, effect: tool.effect, args });
  if (!decision.allow) {
    log(`Denied '${name}' at ${decision.deniedAt}: ${decision.reason}`);
    return errorResponse(decision.reason);
  }

  // Reads are not audited. An audit log that records every read drowns the
  // effectful records it exists to preserve, and reads are already bounded
  // by what the tools expose.
  if (tool.effect === "read") {
    return await runHandler(tool, name, args, ctx);
  }

  const resourceId = resourceIdFor(tool, args);
  const payload = approvalPayload(args);

  // 3. Audit the INTENT, before the effect.
  //
  // This is the ordering correction the module exists for: a record written
  // only after the call is lost if the process dies between the two, and on
  // an idempotency-marked path that record is never backfilled. An intent
  // with no matching outcome is precisely the signal an incident needs.
  let correlationId = null;
  try {
    correlationId = auditIntent({ action: name, resourceId, payload });
  } catch (err) {
    // refuseIfUnauditable throws by design. The gate already checked
    // writability, so reaching here means the log became unwritable in the
    // window between the two, which is exactly the race the check exists for.
    log(`Refusing '${name}': ${errDetail(err)}`);
    return errorResponse(`Refusing to act: the audit log is not writable.`);
  }

  // 4. Dry run stops here, having proved everything except the effect.
  if (decision.dryRun) {
    auditOutcome(correlationId, { status: "dry-run", detail: "no effect performed" });
    return textResponse(
      `DRY RUN. '${name}' would have run against ${resourceId || "(no resource id)"} ` +
        `with payload ${payloadDigest(payload)}. ` +
        "No effect was performed and no approval was consumed. " +
        "Set MCP_DRY_RUN=false to act for real."
    );
  }

  // 5. Spend the approval, then act.
  //
  // Consumption happens before the call, not after. A token consumed after a
  // successful call would still be spendable if the call succeeded and the
  // process then died, which is a replay window. Consuming first can waste an
  // approval on a failed call, and that is the cheaper of the two mistakes.
  const spent = decision.consume();
  if (!spent.ok) {
    auditOutcome(correlationId, { status: "denied", detail: spent.reason });
    return errorResponse(`Confirmation rejected: ${spent.reason}`);
  }

  const result = await runHandler(tool, name, args, ctx);
  auditOutcome(correlationId, {
    status: result?.isError ? "failed" : "ok",
    detail: result?.isError ? "handler returned an error result" : ""
  });
  return result;
}

/* ---- internals --------------------------------------------------------- */

// The one catch site for handler failures. Kept separate so the audit
// outcome above records what actually happened rather than what was
// attempted.
async function runHandler(tool, name, args, ctx) {
  try {
    return await tool.handler(args, ctx);
  } catch (err) {
    const detail = errDetail(err);
    log(`Tool call failed: ${detail}`);
    return errorResponse(`Tool '${name}' failed: ${detail}`);
  }
}
