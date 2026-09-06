/**
 * =========================================================================
 *  SHARED UTILITIES
 * =========================================================================
 * Small pure helpers with no I/O and no side effects. Imported all over:
 * anything that would otherwise appear in two files belongs here.
 */

/**
 * Coerce a boolean-ish value to a real boolean.
 *
 * Open-weight and hosted models alike frequently emit booleans as strings
 * ("true"/"false"), numbers (1/0), or omit them entirely. If a tool schema
 * accepts a flag with `type: ["boolean","string"]`, never compare it against
 * a literal `true`/`false` - run it through `asBool` first.
 */
export function asBool(v, dflt = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(s)) return true;
    if (["false", "0", "no", "n", ""].includes(s)) return false;
  }
  return dflt;
}

/**
 * Extract a useful error detail from an axios-shaped error, for logging or
 * showing to a tool caller, WITHOUT leaking an Authorization header some
 * APIs echo back verbatim on 401/403 responses.
 *
 * Redaction is two-layered on purpose. Key matching alone has two leaks:
 * a NON-object body (a proxy's HTML error page, a gateway's plain-text 401,
 * exactly the responses that echo request diagnostics) passes through
 * key-based redaction untouched, and a token quoted INSIDE another key's
 * string value ("message": "rejected: authorization: Bearer ...") survives
 * because only the key name was checked. Strings are therefore scrubbed by
 * pattern wherever they appear: bare bearer tokens, and anything following
 * an "authorization:"-shaped prefix.
 */
const TOKEN_PATTERNS = [
  // The scheme gives these away regardless of surrounding text.
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi,
  // "Authorization: <anything-up-to-whitespace>" in prose or headers-as-text.
  /\b(authorization\s*[:=]\s*)[^\s"',;]+/gi
];

/**
 * Scrub credential-shaped substrings out of free text.
 *
 * Exported because more than one subsystem has to redact, and every one of
 * them must use the SAME patterns. A caller that copies these regexes is
 * correct exactly until someone tightens them here, at which point the copy
 * silently becomes the one place still writing a live token to disk.
 */
export function redactString(s) {
  let out = s;
  out = out.replace(TOKEN_PATTERNS[0], "$1 [redacted]");
  out = out.replace(TOKEN_PATTERNS[1], "$1[redacted]");
  return out;
}

export function errDetail(err) {
  const data = err?.response?.data;
  if (data == null) return err?.message ?? String(err);
  try {
    return typeof data === "string" ? redactString(data) : JSON.stringify(redactAuth(data));
  } catch {
    return err?.message ?? "unknown error";
  }
}

/**
 * Redact any value: walks objects and arrays, scrubs strings by pattern, and
 * blanks an `authorization` key outright wherever it appears.
 *
 * Use this, NOT `errDetail`, when the thing being scrubbed is an ordinary
 * value rather than a thrown error. `errDetail` expects an axios-shaped
 * error and reaching it with a hand-built `{ response: { data } }` envelope
 * just to borrow its redaction is a sign this export was what you wanted.
 */
export function redactAuth(obj) {
  if (typeof obj === "string") return redactString(obj);
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactAuth);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/^authorization$/i.test(k)) out[k] = "[redacted]";
    else out[k] = redactAuth(v);
  }
  return out;
}
