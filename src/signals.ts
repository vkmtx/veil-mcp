/**
 * Content-aware signal extraction.
 *
 * Positional head+tail condensing (render.ts) is blind to the MIDDLE of a long
 * stream — a single `FAIL`/`error`/`warning` line buried there is silently
 * elided, so a success-shaped quiet result can hide a real problem. This module
 * scans a slice of lines for failure/warning signal and returns the salient
 * ones (deduped), so the renderer can surface them even while hiding the
 * bulk. It is the one place responsible for "what in this output matters".
 */

// Word/glyph signals are case-insensitive; the pytest-style `E`/`FAIL` line anchor
// is case-SENSITIVE (a /i flag here would flag any line starting with a lone "e").
const SIGNAL_CI =
  /\b(errors?|fail(?:ed|ure|ing|s)?|fatal|panic|exception|traceback|denied|cannot|unable|warn(?:ing)?s?|deprecat\w*|abort(?:ed|ing)?|killed|segfault|segmentation\s+fault|core\s+dumped|sig(?:segv|abrt|bus|kill|term|ill|fpe)|oom|out\s+of\s+memory|conflict|rejected|undefined\s+reference|symbols?\s+not\s+found|not\s+found|timed?\s*out|timeout|vulnerabilit\w+|unhealthy|refused|reset\s+by\s+peer|no\s+such\s+file)\b|✗|✘/i;
const SIGNAL_CS = /^\s*(?:E\b|FAIL\b)/;

/**
 * Return salient lines from `lines`, labeled with a line number. `startLine` is
 * the 0-based index of `lines[0]` within the displayed body; labels are exact for
 * untruncated output and approximate (relative to the retained tail) when the
 * stream was byte-capped. `exclude` seeds the dedup set (e.g. with the already-shown
 * head+tail) so a surfaced line is never a duplicate of one already visible.
 */
export function extractSignals(
  lines: string[],
  startLine = 0,
  exclude: Set<string> = new Set(),
): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  // Scan EVERY line — no cap here. The caller (render) decides how many to show
  // inline and reports the TRUE total, so a 6th+ distinct mid-stream signal is
  // never silently dropped from the count.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line || !(SIGNAL_CI.test(line) || SIGNAL_CS.test(line))) continue;
    const key = line.trim();
    if (seen.has(key)) continue; // collapse repeated identical error spam / head+tail dupes
    seen.add(key);
    out.push(`L${startLine + i + 1}: ${line.slice(0, 200)}`);
  }
  return out;
}
