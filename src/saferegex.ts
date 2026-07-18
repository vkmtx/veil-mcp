/**
 * Compile a user/agent-supplied regex, refusing patterns likely to cause CATASTROPHIC
 * BACKTRACKING (ReDoS). The MCP server is single-threaded, so one pathological match (e.g.
 * `(a+)+$` against a long non-matching line) wedges the whole event loop — every other
 * request stalls. Node has no native per-match regex timeout, so this is a STATIC guard:
 *
 *  - cap the pattern length, and
 *  - reject the classic nested-quantifier signature: a group that contains a quantifier and
 *    is ITSELF quantified — `(a+)+`, `(a*)*`, `(\d+)*`, `(ab+)+` …
 *
 * Not an exhaustive ReDoS detector (it doesn't catch every overlapping-alternation case),
 * but it stops the common footguns and turns a wedged event loop into a clear, returnable
 * error. Also surfaces invalid-syntax errors through the same channel.
 */
export const MAX_REGEX_LEN = 1000;

// A group `(…)` whose body contains `+`/`*` and which is immediately followed by `+`/`*`.
// `[^()]*` keeps it to a single (non-nested) group so a benign `(a+)b+` — quantifier on `b`,
// not on the group — does not match.
const NESTED_QUANT = /\([^()]*[+*][^()]*\)[+*]/;

export function compileSafe(pattern: string, flags?: string): { re?: RegExp; error?: string } {
  if (pattern.length > MAX_REGEX_LEN) {
    return { error: `regex too long (${pattern.length} > ${MAX_REGEX_LEN} chars)` };
  }
  if (NESTED_QUANT.test(pattern)) {
    return { error: "regex rejected: a nested quantifier can cause catastrophic backtracking — simplify the pattern" };
  }
  try {
    return { re: new RegExp(pattern, flags) };
  } catch (e) {
    return { error: `invalid regex: ${e instanceof Error ? e.message : String(e)}` };
  }
}
