/**
 * Shared, deterministic metric data — imported by BOTH bench/metrics.ts (which
 * prints the published numbers) and test/smoke.ts (which asserts them), so the
 * advertised figures and the gate can never drift apart.
 */

export interface Turn {
  task: string;
  raw: number; // MCP/shell round-trips with raw Bash
  veil: number; // round-trips with veil (one structured call does the verify/effect/retry)
  why: string;
}

/** Common agent tasks where structure + effects + expect + retry collapse a
 *  run→check→grep loop into a single call. Counts CALLS, not bytes — the value that
 *  survives growing context windows. */
export const TURNS: Turn[] = [
  { task: "build + verify artifact exists", raw: 2, veil: 1, why: "raw: build, then `test -f dist/x`; veil: sh_run + expect.file_exists" },
  { task: "run + confirm exit 0, stderr empty", raw: 2, veil: 1, why: "raw: cmd, then inspect $? and stderr; veil: expect.exit + stderr_empty" },
  { task: "edit + list files changed", raw: 2, veil: 1, why: "raw: cmd, then `git status`; veil: files_changed in the result" },
  { task: "grep a value from a 50k-line log", raw: 2, veil: 1, why: "raw: re-run the cmd | grep; veil: sh_detail match (no re-run)" },
  { task: "retry a flaky install up to 3x", raw: 3, veil: 1, why: "raw: up to 3 manual re-invocations; veil: retries:3 in one call" },
];

export interface RecallCase {
  name: string;
  fail: string; // a real failure line that must be surfaced even when buried mid-stream
}

/** Labeled corpus: each entry's `fail` is a genuine failure idiom — several of them
 *  contain NO error/fail keyword, so they exercise the extended lexicon. */
export const recallCorpus: RecallCase[] = [
  { name: "C build segfault", fail: "Segmentation fault (core dumped)" },
  { name: "OOM-killed process", fail: "Killed" },
  { name: "git merge conflict", fail: "CONFLICT (content): Merge conflict in src/app.ts" },
  { name: "git push rejected", fail: "! [rejected]        main -> main (non-fast-forward)" },
  { name: "linker undefined ref", fail: "undefined reference to 'parse_config'" },
  { name: "macOS linker miss", fail: "ld: symbol(s) not found for architecture arm64" },
  { name: "network timeout", fail: "Operation timed out after 30000 ms" },
  { name: "npm audit", fail: "found 3 high severity vulnerabilities" },
  { name: "pytest failure", fail: "FAILED tests/test_login.py::test_redirect - assert 200 == 404" },
  { name: "python traceback", fail: "Traceback (most recent call last):" },
];

/** Build a fixture whose failure line sits in the ELIDED MIDDLE (not head/tail), run
 *  it through the condenser, and report whether the failure was surfaced. `condense`
 *  is injected so this data module stays dependency-free. */
export function recallSurfaced(c: RecallCase, condense: (text: string, id: string, sel: string) => string): boolean {
  const N = 80; // > inlineMaxLines (45) and > headLines+tailLines (40) → middle is elided
  const mid = Math.floor(N / 2);
  const lines = Array.from({ length: N }, (_, i) => (i === mid ? c.fail : `step ${i} ok`));
  return condense(lines.join("\n"), "u", "stdout").includes(c.fail);
}
