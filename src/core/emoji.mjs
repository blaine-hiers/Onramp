/**
 * =========================================================================
 * EMOJI CONSTANTS
 * =========================================================================
 * User-visible emoji used by tool output, defined once via `\u{...}`
 * escapes so the codepoints survive tooling that strips literal emoji from
 * source files, and so every renderer imports from ONE place instead of
 * open-coding characters that look identical but aren't. Add more here as
 * your tools need them.
 */

// Status
export const OK   = "\u{2705}"; // white heavy check mark
export const WARN = "\u{26A0}\u{FE0F}"; // warning
