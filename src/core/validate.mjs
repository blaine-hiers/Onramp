/**
 * =========================================================================
 * INPUT SCHEMA VALIDATION
 * =========================================================================
 * Enforces a tool's declared `inputSchema` against the arguments actually
 * received, and closes the sharpest gap in this template: server.mjs uses
 * the low-level SDK `Server` class, which validates the JSON-RPC ENVELOPE
 * and nothing inside it. Today `required: ["message"]` is documentation
 * aimed at a model, not a constraint, so a handler can be entered with
 * that property missing, a number where it declared a string, or twenty
 * undeclared keys, and the first thing to notice is a stack trace from
 * deep inside an integration.
 *
 * Hand-written on purpose, with NO new dependency. A full JSON Schema
 * library is a large transitive tree in a template whose whole selling
 * point is that it starts empty, and the subset actually used by MCP tool
 * schemas is small enough to read in one sitting. Read the UNSUPPORTED
 * list below before assuming a keyword works.
 *
 * SUPPORTED: type (string, number, integer, boolean, object, array, plus
 * an array of those for a union), required, enum, minimum, maximum,
 * minLength, maxLength, items, properties, additionalProperties.
 *
 * UNSUPPORTED, and silently ignored rather than half-honored: $ref and
 * $defs, allOf / anyOf / oneOf / not, pattern and patternProperties,
 * format, const, dependencies and dependentRequired, uniqueItems,
 * minItems / maxItems, minProperties / maxProperties, multipleOf,
 * exclusiveMinimum / exclusiveMaximum, tuple form `items: [...]`, the
 * "null" type, and `default` (this module NEVER fills a value in). If a
 * tool needs one of those, the check belongs in the handler where the
 * failure can be explained in the tool's own terms.
 *
 * It also never COERCES. A model that sends "true" for a boolean gets an
 * error, not a silent fix, because a validator that quietly rewrites its
 * input teaches the model nothing and hides the schema drift. A tool that
 * genuinely wants to accept model-ish strings declares
 * `type: ["boolean", "string"]` and runs `asBool` from src/core/util.mjs.
 */

// A cap on how many problems one call can report. WHY: an array of 5,000
// bad items would otherwise produce 5,000 error objects, and that whole
// list goes back to a model as text, burning its context on the same
// mistake repeated. The first handful is what gets a call fixed.
const MAX_ERRORS = 25;

// Every type keyword this validator understands, mapped to its test. An
// unknown type name (say "null" or a typo) is NOT in this table and is
// skipped rather than failing every value, so an unsupported keyword
// degrades to "unchecked" instead of "nothing can ever be valid".
const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  // Number rejects NaN and Infinity. JSON cannot carry either, but a
  // handler called directly from a test or another module can, and a NaN
  // that passes a minimum check is a bug that surfaces three files away.
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  // An array is typeof "object", so the array test has to come first in
  // spirit: object means a plain object here, which is what a JSON Schema
  // `type: "object"` means to everyone reading the schema.
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v)
};

/**
 * Validate `args` against a tool's `inputSchema`.
 *
 * Returns `{ ok, errors }` where errors is an array of `{ path, reason }`.
 * NEVER throws: this runs on the request path in server.mjs, and a
 * validator that can throw turns a bad argument into a dead connection
 * instead of a message the caller can act on.
 *
 * Errors are COLLECTED, not short-circuited on the first one, so a model
 * repairing its call sees every problem in a single turn rather than
 * discovering them one round trip at a time.
 */
export function validateArgs(schema, args) {
  const errors = [];
  try {
    // A schema that is absent or not an object fails CLOSED. Every entry
    // in registry.mjs is expected to carry an inputSchema (its own test
    // asserts as much), so reaching here without one means the tool is
    // malformed, and the alternative reading, "no schema, therefore no
    // constraints, therefore allow everything", is precisely the gap this
    // module exists to close.
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      return {
        ok: false,
        errors: [
          {
            path: "(root)",
            reason: "inputSchema is missing or is not an object; refusing to validate"
          }
        ]
      };
    }

    // An MCP call with no arguments arrives as undefined or as {}. Both
    // are treated as an empty object so that a schema with `required`
    // reports each missing property by name, which is actionable, rather
    // than one "expected object" error at the root, which is not.
    const value = args === undefined || args === null ? {} : args;

    checkValue(schema, value, "", errors);
  } catch (err) {
    // Belt and braces around the promise above. If this validator ever
    // has a bug, the request must fail closed rather than be waved
    // through unvalidated on the strength of an empty error list.
    errors.push({
      path: "(root)",
      reason: `validator failed: ${err?.message ?? String(err)}`
    });
  }
  return { ok: errors.length === 0, errors };
}

// Dotted and bracketed paths, built as the walk descends, so the error a
// model reads names the exact argument to fix: "filters.tags[2]", not
// "somewhere in filters". The root itself has no name, hence the empty
// string, and a top level property is therefore just "message".
function childPath(path, key) {
  return path === "" ? String(key) : `${path}.${key}`;
}

function indexPath(path, index) {
  return `${path}[${index}]`;
}

// A single push point so the MAX_ERRORS cap cannot be bypassed by a new
// call site added later. Returns false once the list is full, which the
// loops below use to stop walking a large array early.
function addError(errors, path, reason) {
  if (errors.length >= MAX_ERRORS) return false;
  // On the last slot, the real error goes in AND a marker after it.
  // Without the marker a truncated list looks like a complete one, and a
  // model would fix 25 problems, retry, and be told about 25 more.
  if (errors.length === MAX_ERRORS - 1) {
    errors.push({ path: path === "" ? "(root)" : path, reason });
    errors.push({
      path: "(root)",
      reason: `further errors suppressed at ${MAX_ERRORS} problems`
    });
    return false;
  }
  errors.push({ path: path === "" ? "(root)" : path, reason });
  return true;
}

// The recursive core. Every keyword is checked independently and all of
// them report, except that a value which failed its `type` check is not
// then measured against `minimum` or `minLength`: "expected a number, got
// a string" plus "value is below the minimum" describes one mistake twice
// and the second half is nonsense.
function checkValue(schema, value, path, errors) {
  // A subschema that is not an object (a stray `true`, a string left by a
  // half-finished edit) constrains nothing. Skipping it keeps one bad
  // property from failing every call to an otherwise healthy tool.
  if (schema === null || typeof schema !== "object") return;

  // The type gate returns false when it has already reported, and the
  // remaining keywords are skipped for that value: see the note above.
  if (!checkType(schema, value, path, errors)) return;

  checkEnum(schema, value, path, errors);
  checkRange(schema, value, path, errors);
  checkLength(schema, value, path, errors);

  if (Array.isArray(value)) {
    checkItems(schema, value, path, errors);
  } else if (value !== null && typeof value === "object") {
    checkObject(schema, value, path, errors);
  }
}

// `type` accepts a single name or an array of them (a union). The union
// form is supported because this codebase already recommends it: see the
// note on `asBool` in src/core/util.mjs about models emitting booleans as
// strings, which is spelled `type: ["boolean", "string"]` in a schema.
function checkType(schema, value, path, errors) {
  const declared = schema.type;
  if (declared === undefined) return true;

  const names = Array.isArray(declared) ? declared : [declared];
  // Only the names this validator knows about count. A schema listing
  // solely unsupported type names leaves the value unchecked, which is
  // the documented degradation, not a silent pass of a known-bad value.
  const known = names.filter((n) => typeof n === "string" && n in TYPE_CHECKS);
  if (known.length === 0) return true;

  if (known.some((n) => TYPE_CHECKS[n](value))) return true;

  addError(
    errors,
    path,
    `expected ${known.join(" or ")}, received ${describe(value)}`
  );
  return false;
}

// Naming what actually arrived matters more than naming what was wanted:
// a model that sent 3 for a string can only fix the call if the error
// says a number showed up.
function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "a non-finite number";
  if (typeof value === "number" && !Number.isInteger(value)) return "a fractional number";
  return typeof value;
}

// Primitive membership only. Object and array enum members are compared
// by identity here, which would be a surprising near-miss, so they are
// listed as unsupported in the banner rather than half-implemented.
function checkEnum(schema, value, path, errors) {
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) return;
  if (schema.enum.some((member) => member === value)) return;
  addError(
    errors,
    path,
    `must be one of: ${schema.enum.map((m) => JSON.stringify(m)).join(", ")}`
  );
}

// minimum and maximum are INCLUSIVE, per JSON Schema. The exclusive forms
// are not supported, so a schema using them gets no bound at all rather
// than an off-by-one one that nobody notices until a zero slips through.
function checkRange(schema, value, path, errors) {
  if (typeof value !== "number") return;
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    addError(errors, path, `must be >= ${schema.minimum}, received ${value}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    addError(errors, path, `must be <= ${schema.maximum}, received ${value}`);
  }
}

// Length applies to strings only. JSON Schema's array size keywords are
// minItems/maxItems, which this validator does not support, so a
// minLength sitting on an array schema is ignored rather than quietly
// repurposed into a check the schema author never asked for.
function checkLength(schema, value, path, errors) {
  if (typeof value !== "string") return;
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    addError(
      errors,
      path,
      `must be at least ${schema.minLength} characters, received ${value.length}`
    );
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    addError(
      errors,
      path,
      `must be at most ${schema.maxLength} characters, received ${value.length}`
    );
  }
}

// One `items` schema applies to every element. The tuple form (`items` as
// an array of per-position schemas) is unsupported and skipped: MCP tool
// schemas do not use it, and a tuple silently validated as a single
// schema would report confident nonsense on every element.
function checkItems(schema, value, path, errors) {
  const itemSchema = schema.items;
  if (itemSchema === null || typeof itemSchema !== "object") return;
  if (Array.isArray(itemSchema)) return;
  for (let i = 0; i < value.length; i += 1) {
    // Stop as soon as the cap is reached: a 5,000 element array should
    // not cost 5,000 recursive walks to produce a list already full.
    if (errors.length >= MAX_ERRORS) return;
    checkValue(itemSchema, value[i], indexPath(path, i), errors);
  }
}

// `required`, `properties` and `additionalProperties`, in that order, so
// a missing property is reported before the noise from whatever else the
// caller got wrong in the same object.
function checkObject(schema, value, path, errors) {
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      // Present-but-undefined counts as missing. An MCP client that
      // serializes `{ message: undefined }` drops the key on the wire
      // anyway, so treating the two differently would make the same call
      // pass locally and fail over stdio.
      if (value[key] === undefined) {
        addError(errors, childPath(path, key), "required property is missing");
      }
    }
  }

  // Missing `properties` becomes an empty map rather than a reason to
  // skip the rest. That matters for the strictest combination a schema
  // can express, `properties` absent with additionalProperties: false,
  // which declares an object that takes no arguments at all: with a skip
  // here, that schema would accept every key instead of none.
  const properties =
    schema.properties !== null && typeof schema.properties === "object"
      ? schema.properties
      : {};

  for (const [key, propSchema] of Object.entries(properties)) {
    // An absent optional property is not an error, and it must not be
    // walked either: checking `undefined` against `type: "string"` would
    // report every optional property the caller sensibly left out.
    if (value[key] === undefined) continue;
    checkValue(propSchema, value[key], childPath(path, key), errors);
  }

  checkAdditional(schema, value, properties, path, errors);
}

// `additionalProperties: false` rejects undeclared keys. An object form
// validates each extra against that schema (a map of same-shaped values);
// anything else, including the absent case, permits extras, which is the
// JSON Schema default.
//
// NOTE: rejecting extras is the reason a typo like "mesage" surfaces as a
// clear error instead of as a required-property complaint the model
// cannot reconcile with the payload it believes it sent.
function checkAdditional(schema, value, properties, path, errors) {
  const additional = schema.additionalProperties;
  if (additional === undefined || additional === true) return;

  // Object.hasOwn, NOT `in`. With `in`, an argument named "toString" or
  // "constructor" matches Object.prototype, so the schema would look as
  // though it had declared that property and additionalProperties: false
  // would wave through exactly the keys most worth catching.
  const extras = Object.keys(value).filter((key) => !Object.hasOwn(properties, key));
  if (extras.length === 0) return;

  if (additional === false) {
    for (const key of extras) {
      if (
        !addError(
          errors,
          childPath(path, key),
          "unexpected property; this schema declares additionalProperties: false"
        )
      ) {
        return;
      }
    }
    return;
  }

  if (additional !== null && typeof additional === "object" && !Array.isArray(additional)) {
    for (const key of extras) {
      if (errors.length >= MAX_ERRORS) return;
      checkValue(additional, value[key], childPath(path, key), errors);
    }
  }
}

/**
 * Render a validation result as one line of text for a tool caller.
 *
 * Kept here rather than at each call site so every tool reports a failure
 * in the same shape, and so the wording stays aimed at the reader that
 * actually receives it: a model repairing its own call, which needs the
 * path and the reason and nothing else.
 */
export function formatErrors(result) {
  if (!result || result.ok) return "";
  return result.errors.map((e) => `${e.path}: ${e.reason}`).join("; ");
}
