/** Feature I — token-aware rendering. Quiet by default; head+tail when verbose. */

import { config } from "./config.js";
import { extractSignals } from "./signals.js";

/**
 * Collapse carriage-return progress frames (`a\rb\rc` with no LF → last frame)
 * and treat a lone `\r` as a separator, while leaving real CRLF intact (the
 * `\r\n` is consumed as one separator). Without this, a progress-bar stream of
 * hundreds of CR-overwritten frames counts as ONE giant line and gets dumped
 * inline as "short" — defeating the quiet contract.
 */
function normalizeCR(s: string): string {
  if (s.indexOf("\r") === -1) return s;
  s = s.replace(/\r\n/g, "\n");
  return s
    .split("\n")
    .map((seg) => (seg.indexOf("\r") === -1 ? seg : seg.slice(seg.lastIndexOf("\r") + 1)))
    .join("\n");
}

export function lineCount(s: string): number {
  s = normalizeCR(s);
  if (s.length === 0) return 0;
  return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}

/**
 * Condense a stream for inline display. Short streams pass through whole; long
 * ones become head + an elision pointer (+ any salient hidden-region lines) +
 * tail. The hidden lines stay retrievable via sh_detail (feature J).
 *
 * When `opts.truncated` is set the underlying buffer kept only the TAIL (oldest
 * bytes dropped at the byte cap), so its first physical line is a torn mid-stream
 * fragment and the "head" is NOT the start of output. We drop the torn fragment
 * and prepend an honest marker, so the agent never reads mid-stream lines as the
 * beginning.
 */
export function condense(
  text: string,
  id: string,
  selector: string,
  opts: { truncated?: boolean } = {},
): string {
  const trunc = opts.truncated === true;
  let body = normalizeCR(text);
  const prefix: string[] = [];
  if (trunc) {
    const nl = body.indexOf("\n");
    if (nl >= 0) body = body.slice(nl + 1); // drop the torn first fragment
    prefix.push(
      `… [${selector} truncated at byte cap: earliest output dropped, showing tail only — full retained stream via sh_detail id=${id} selector=${selector}] …`,
    );
  }

  const lines = body.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const { inlineMaxLines, headLines, tailLines, maxLineChars } = config;
  // Condensing is line-based, so a single very long line (or many wide lines) would
  // bypass the line cap and dump megabytes inline. Cap each emitted line's WIDTH too,
  // leaving a pointer to the full bytes in sh_detail.
  const cap = (l: string): string =>
    l.length <= maxLineChars
      ? l
      : `${l.slice(0, maxLineChars)} … [+${l.length - maxLineChars} chars — sh_detail id=${id} selector=${selector}]`;

  // Guard: if the head+tail window can't actually hide anything, return whole (capped).
  if (lines.length <= inlineMaxLines || lines.length <= headLines + tailLines) {
    return [...prefix, ...lines.map(cap)].join("\n");
  }

  const head = lines.slice(0, headLines).map(cap);
  const tail = lines.slice(-tailLines).map(cap);
  const hidden = lines.length - headLines - tailLines;
  // Surface failure/warning signal buried in the elided MIDDLE so a quiet success
  // can't hide a mid-stream FAIL/warning. Scans only the hidden region, and excludes
  // anything already visible in head/tail so nothing is rendered twice.
  const shown = new Set([...head, ...tail].map((l) => l.trim()));
  const flagged = extractSignals(lines.slice(headLines, lines.length - tailLines), headLines, 5, shown);
  const marker =
    flagged.length > 0
      ? `… [${hidden} lines hidden, ${flagged.length} flagged — pull with sh_detail id=${id} selector=${selector}] …`
      : `… [${hidden} lines hidden — pull with sh_detail id=${id} selector=${selector}] …`;
  return [...prefix, ...head, marker, ...flagged, ...tail].join("\n");
}
