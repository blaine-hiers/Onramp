/**
 * =========================================================================
 * EFFECT CLASSES AND THE ORDERED GATE
 * =========================================================================
 * Every tool declares what it can do to the world: "read", "write", or
 * "irreversible". That declaration is the input to an ordered sequence of
 * checks, and this module is where the sequence lives.
 *
 * WHY the order matters, and why it is fixed: each step either short
 * circuits or cheapens the next, and a denial names the step that produced
 * it. A caller that gets back `deniedAt: "accountability"` knows the audit
 * log is unwritable; one that gets `deniedAt: "approval"` knows it needs a
 * confirm token. A single boolean would tell them nothing, and a reordering
 * would change the semantics silently. The tests assert on `deniedAt` for
 * exactly that reason: moving a step breaks a test rather than quietly
 * changing what the server permits.
 *
 * Reads are ungated, deliberately and out loud. An undocumented ungated
 * path is the problem; a documented one is a decision.
 */

import { createHash } from "node:crypto";

import { CONFIG } from "./config.mjs";
import { auditWritable } from "./audit.mjs";
import { validateConfirmToken, consumeConfirmToken } from "./confirm.mjs";

/**
 * The three effect classes, in increasing order of what they can cost you.
 *
 * The axis is OUTWARD effect, and only outward effect. A tool's own local
 * bookkeeping (a cache, a cursor, an approval it minted into var/state) does
 * NOT make it a write, because none of it is visible to anyone but this
 * process and none of it survives deleting var/.
 *
 * "read"          reaches nothing outside the process. May keep local state.
 * "write"         reaches something outside the process, but the change can be
 *                 undone or repeated without harm.
 * "irreversible"  reaches something that cannot be taken back: mail sent, a
 *                 payment moved, a record destroyed. This is the only class
 *                 that requires a confirm token.
 *
 * WHY the axis is outward effect rather than "does it write anything": dry
 * run short circuits everything above "read", and the first version of this
 * template classified the token-minting half of a two-phase pair as a write.
 * The result was that a freshly cloned server could never mint an approval,
 * so the two-phase flow could not be exercised at all until the operator
 * turned off the very safety that made it interesting. A taxonomy that makes
 * the safe path unusable gets switched off, and then nothing is gated.
 */
export const EFFECT_CLASSES = Object.freeze(["read", "write", "irreversible"]);

/** True when `v` is one of the three declared effect classes. */
export function isEffectClass(v) {
  return EFFECT_CLASSES.includes(v);
}

/**
 * True when this call may not proceed on the model's say-so alone.
 *
 * "irreversible" always qualifies. Requiring a token for every write would
 * train operators to mint tokens reflexively, which is how a confirmation
 * step turns into a rubber stamp.
 *
 * An operator can ALSO escalate a named tool with MCP_CONFIRM_REQUIRED_EXTRA,
 * which is the point of that list: you may not trust a third-party
 * integration's own declaration of how dangerous it is, and editing someone
 * else's tool file to tighten it is a change you then have to carry forever.
 * The list only ever tightens. There is deliberately no way to spend it in
 * the other direction and exempt an irreversible tool from approval.
 */
export function requiresApproval(effect, name) {
  if (effect === "irreversible") return true;
  if (!name) return false;
  return CONFIG.CONFIRM_REQUIRED_TOOLS.includes(name);
}

/**
 * The argument name an irreversible tool reads its approval from.
 *
 * Exported so the dispatcher can strip it before hashing: the token cannot
 * be part of the payload it authorizes, or the hash would depend on the
 * token and no token could ever match.
 */
export const CONFIRM_ARG = "confirm_token";

/**
 * Canonical resource identity for a call.
 *
 * A tool record may supply `resourceId(args)` when its target is not a plain
 * `resource_id` argument. Falling back to the literal argument keeps the
 * common case free of ceremony.
 */
export function resourceIdFor(tool, args) {
  if (typeof tool?.resourceId === "function") {
    try {
      return String(tool.resourceId(args) ?? "");
    } catch {
      // A throwing identity function must not become a crash in the gate.
      // An empty id fails the approval check below, which is the safe end.
      return "";
    }
  }
  return String(args?.resource_id ?? "");
}

/**
 * The payload a confirm token is bound to: the arguments minus the token.
 *
 * IMPORTANT: the token is excluded on both sides, at mint and at consume.
 * Include it and the hash covers the very value being checked, so approval
 * becomes impossible. Excluding it is what makes the binding meaningful:
 * the token authorizes THESE arguments and no others.
 */
export function approvalPayload(args) {
  const { [CONFIRM_ARG]: _omit, ...rest } = args ?? {};
  return rest;
}

/** Short, stable digest of a payload, used only for audit correlation. */
export function payloadDigest(payload) {
  return createHash("sha256")
    .update(JSON.stringify(payload ?? {}))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Run the ordered decision for one call.
 *
 * Returns `{ allow, deniedAt, reason, dryRun, consume }`. `consume` is a
 * function the caller invokes ONLY once it is committed to performing the
 * effect, because consuming a token is itself irreversible. Splitting the
 * decision from the consumption is what lets a dry run validate an approval
 * without spending it.
 *
 * The steps, in order:
 *
 *   1. class          the tool declared a known effect class
 *   2. mode           dry run or live (never a denial, it selects the path)
 *   3. accountability the audit log is provably writable, for anything that
 *                     is not a read
 *   4. approval       a valid, unconsumed, correctly bound confirm token,
 *                     for the irreversible class only
 */
export async function gate({ name, tool, effect, args }) {
  // 1. Class. An undeclared or misspelled class must never fall through to
  // "probably a read". The registry already refuses to load such a tool, so
  // reaching here means something constructed a record by hand.
  if (!isEffectClass(effect)) {
    return deny("class", `Tool '${name}' declares no valid effect class.`);
  }

  // An operator escalation outranks the tool's own declaration, and it has to
  // be resolved BEFORE the read short circuit below.
  //
  // WHY, and this was a real bug: MCP_CONFIRM_REQUIRED_EXTRA exists precisely
  // because you may not trust a third-party integration's claim about how
  // dangerous it is. Consulting the escalation list only after reads had
  // already been waved through meant escalating a tool that declared itself a
  // read did exactly nothing, silently. The one case the knob was built for
  // was the one case it could not serve.
  //
  // An escalated tool is treated as irreversible for the whole remainder of
  // the decision, so it also picks up the dry run and the audit record. An
  // operator who says "this needs confirmation" is telling you they consider
  // it effectful, and gating the approval while skipping the audit would
  // record nothing about the call they were most worried about.
  const escalated = requiresApproval(effect, name);
  const effective = escalated ? "irreversible" : effect;

  // Reads stop here. Stated out loud rather than left implicit: a read
  // performs no outward effect, so there is nothing for the later steps to
  // protect. If a "read" tool can change something, it was misdeclared.
  if (effective === "read") {
    return { allow: true, deniedAt: null, reason: "", dryRun: false, consume: noop };
  }

  // 2. Mode. Dry run is not a denial, it selects which path runs. It
  // defaults to true so a freshly cloned server cannot reach out and touch
  // anything before its operator has decided that it should.
  const dryRun = CONFIG.DRY_RUN === true;

  // 3. Accountability. A live write must never happen unless the record of
  // it can be written. A dry run is exempt because it performs no effect,
  // and refusing to preview because the log is full would be obstruction
  // without a corresponding safety gain.
  if (!dryRun) {
    const writable = await auditWritable();
    if (!writable.ok) {
      return deny("accountability", `Audit log is not writable: ${writable.reason}`);
    }
  }

  // 4. Approval. Irreversible, plus anything the operator escalated.
  if (effective === "irreversible") {
    const token = args?.[CONFIRM_ARG];
    if (!token) {
      // Name the REASON it needs approval. "is irreversible" is a lie when a
      // tool that declared itself a read was escalated by the operator, and
      // an operator debugging their own escalation should not be told the
      // tool is something it never claimed to be.
      const because = escalated
        ? "has been escalated by MCP_CONFIRM_REQUIRED_EXTRA and"
        : "is irreversible and";
      return deny(
        "approval",
        `Tool '${name}' ${because} requires a ${CONFIRM_ARG}. ` +
          "Call the matching prepare tool first to obtain one."
      );
    }

    const bound = { resourceId: resourceIdFor(tool, args), payload: approvalPayload(args) };

    // Validate on both paths, consume on neither yet. The dry path never
    // consumes at all: previewing must not burn the approval, or operators
    // learn to skip previewing, which defeats the whole mechanism.
    const check = validateConfirmToken(token, bound);
    if (!check.ok) {
      return deny("approval", `Confirmation rejected: ${check.reason}`);
    }

    return {
      allow: true,
      deniedAt: null,
      reason: "",
      dryRun,
      consume: dryRun ? noop : () => consumeConfirmToken(token, bound)
    };
  }

  return { allow: true, deniedAt: null, reason: "", dryRun, consume: noop };
}

/* ---- internals --------------------------------------------------------- */

function deny(step, reason) {
  return { allow: false, deniedAt: step, reason, dryRun: false, consume: noop };
}

// A no-op that matches the shape `consume` callers expect, so the dispatcher
// never has to branch on whether consumption applies.
function noop() {
  return { ok: true, reason: "" };
}
