/**
 * =========================================================================
 * EXAMPLE: A TWO-PHASE IRREVERSIBLE TOOL
 * =========================================================================
 * A worked example of the pattern that separates this template from a plain
 * MCP scaffold. Delete these two tools once your own irreversible tool
 * follows the same shape.
 *
 * The naive design for gating a destructive action is a `confirm: true`
 * argument on the tool. That is broken, and the reason is worth stating
 * plainly: the confirm flag is supplied by the model, and the model is the
 * thing being gated. A model that has ingested untrusted content earlier in
 * the same session will set `confirm: true` as readily as it sets any other
 * argument. It is not a confirmation, it is a parameter with a reassuring
 * name.
 *
 * So the approval is minted by the SERVER, in a first call, and bound to the
 * exact arguments of the second call. The model cannot forge one, and it
 * cannot obtain approval for a harmless payload and then spend it on a
 * different one.
 *
 * PATTERN, for your own tools:
 *
 *   prepare  effect: "read"          reads the target, shows what would
 *                                    happen, mints a token bound to the
 *                                    exact commit arguments. "read" because
 *                                    it reaches nothing outside the process,
 *                                    only var/state.
 *   commit   effect: "irreversible"  takes the token; the gate in
 *                                    src/core/effect.mjs validates and
 *                                    spends it before your handler runs
 *
 * Your commit handler never checks the token itself. By the time it runs the
 * dispatcher has already validated it, confirmed the audit log is writable,
 * spent the token, and written the intent record. A handler that re-checks
 * is a handler that can get the check wrong.
 */

import { CONFIG } from "../../core/config.mjs";
import { mintConfirmToken } from "../../core/confirm.mjs";
import { respond, textResponse } from "../../core/respond.mjs";
import * as E from "../../core/emoji.mjs";

const CATEGORY = "example";

// Stands in for whatever your commit call actually reaches: a mailbox, a
// payments API, a row in someone else's database. Kept in memory so the
// example is runnable with no credentials and no external service.
const RECORDS = new Map([
  ["rec-1", { id: "rec-1", label: "first example record", deleted: false }],
  ["rec-2", { id: "rec-2", label: "second example record", deleted: false }]
]);

export const tools = [
  {
    category: CATEGORY,
    // "read", even though this writes an approval into var/state.
    //
    // The effect class is about OUTWARD effect only (see src/core/effect.mjs).
    // Minting a token reaches nothing outside the process, so classifying it
    // as a write would be wrong twice over: it would imply this call can
    // affect someone else's system, and it would put phase 1 behind the dry
    // run gate, making the two-phase flow impossible to exercise in the
    // default posture. Phase 2 is where the outward effect lives, and phase 2
    // is what carries the class that demands an approval.
    effect: "read",
    schema: {
      name: "example_prepare_delete",
      description:
        "Phase 1 of 2. Look up an example record and mint a single-use " +
        "confirmation token for deleting it. The token is bound to this " +
        "exact record and expires. Pass it to example_delete to commit.",
      inputSchema: {
        type: "object",
        properties: {
          resource_id: {
            type: "string",
            description: "Id of the record to prepare for deletion."
          }
        },
        required: ["resource_id"],
        additionalProperties: false
      }
    },
    handler: async (args) => {
      const id = String(args?.resource_id ?? "");
      const record = RECORDS.get(id);
      if (!record) return textResponse(`${E.WARN} No example record '${id}'.`);
      if (record.deleted) return textResponse(`${E.WARN} '${id}' is already deleted.`);

      // The payload must be EXACTLY what the commit call will present, minus
      // the token itself. src/core/effect.mjs strips `confirm_token` on the
      // other side and hashes the rest, so anything included here that the
      // commit call will not send (or omitted here that it will) makes the
      // token permanently unspendable.
      const token = mintConfirmToken({
        resourceId: id,
        payload: { resource_id: id },
        ttlMs: CONFIG.CONFIRM_TTL_MS
      });

      if (!token) {
        // mintConfirmToken fails closed and returns an empty string when the
        // approval could not be persisted. An unpersisted token would be
        // rejected at commit anyway; saying so now is the honest answer.
        return textResponse(`${E.WARN} Could not persist a confirmation token.`);
      }

      return respond(
        `${E.OK} Ready to delete '${record.id}' (${record.label}).\n` +
          `confirm_token: ${token}\n` +
          `Expires in ${Math.round(CONFIG.CONFIRM_TTL_MS / 60000)} minutes. Single use.`,
        args,
        `\n\nNext step: example_delete with resource_id '${record.id}' and this token.`
      );
    }
  },

  {
    category: CATEGORY,
    // The real thing. The gate refuses this call without a valid token, and
    // refuses it again if the audit log cannot be written.
    effect: "irreversible",
    schema: {
      name: "example_delete",
      description:
        "Phase 2 of 2. Permanently delete an example record. Requires a " +
        "confirm_token from example_prepare_delete that was minted for this " +
        "exact record.",
      inputSchema: {
        type: "object",
        properties: {
          resource_id: {
            type: "string",
            description: "Id of the record to delete."
          },
          confirm_token: {
            type: "string",
            description: "Single-use token from example_prepare_delete."
          }
        },
        required: ["resource_id", "confirm_token"],
        additionalProperties: false
      }
    },
    handler: async (args) => {
      const id = String(args?.resource_id ?? "");
      const record = RECORDS.get(id);

      // Re-read the target rather than trusting what phase 1 saw. The
      // resource can change between the two calls, and the token binds the
      // arguments, not the state of the world.
      if (!record) return textResponse(`${E.WARN} No example record '${id}'.`);
      if (record.deleted) return textResponse(`${E.WARN} '${id}' is already deleted.`);

      record.deleted = true;
      return textResponse(`${E.OK} Deleted '${id}'.`);
    }
  }
];

/** Test hook: restore the in-memory records between test cases. */
export function resetExampleRecords() {
  for (const record of RECORDS.values()) record.deleted = false;
}
