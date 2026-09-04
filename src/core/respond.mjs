/**
 * =========================================================================
 * MCP TOOL RESPONSE HELPERS
 * =========================================================================
 * The standard shapes every tool handler returns.
 *
 *   respond(text, args, hint)  -> read tools; appends a tool-chaining hint
 *                                 unless the caller passed { no_hint: true }
 *   textResponse(text)         -> write actions ("sent!", "created!")
 *   errorResponse(text)        -> protocol error (sets isError)
 *
 * Kept as three named helpers so the call site reads as its intent and you
 * never open-code `{ content: [{ type: "text", ... }] }` in 30 places.
 */

/**
 * Standard MCP tool response with an optional trailing hint. Every
 * read-tool handler ends with `return respond(text, args, hint);`.
 *
 * `args.no_hint` suppresses the trailing "Next step:" tool-chaining hint —
 * it's guidance for an LLM/MCP client, just noise for a human-facing
 * surface that renders the text directly.
 *
 * Kept `async` (even though it doesn't await anything) so `await respond(...)`
 * call sites work today and stay valid if a helper here ever needs to await.
 */
export async function respond(text, args = {}, hint = "") {
  const finalHint = args.no_hint ? "" : hint;
  return { content: [{ type: "text", text: text + finalHint }] };
}

/**
 * MCP text response for write actions ("sent!" / "created!") that don't
 * need a chaining hint. Kept separate so the call site reads as its intent.
 */
export function textResponse(text) {
  return { content: [{ type: "text", text }] };
}

/** MCP error response — sets `isError` per the protocol. */
export function errorResponse(text) {
  return { isError: true, content: [{ type: "text", text }] };
}
