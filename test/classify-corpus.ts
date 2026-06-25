/**
 * Classifier safety corpus — the historically-risky commands that must NEVER be
 * under-flagged. Each case pins a FLOOR: classify(command).category must rank at
 * least as severe as `minCategory` (the over-flag direction is fine; under-flagging
 * a destructive verb to read-only is the unsafe failure this guards against).
 *
 * The control cases (read-only/mutating) pin an EXACT category instead, so a
 * regression that starts over-flagging benign commands is caught too.
 */
import type { Category } from "../src/classify.js";

export interface CorpusCase {
  command: string;
  /** the LEAST-severe category this command may classify as (see RANK in classify.ts). */
  minCategory: Category;
  /** controls assert exact equality; dangerous cases assert "at least as severe". */
  exact?: boolean;
}

export const CLASSIFY_CORPUS: CorpusCase[] = [
  // ── historically-risky: must be at LEAST destructive ──
  { command: "git clean -f", minCategory: "destructive" },
  { command: "git clean -fd", minCategory: "destructive" },
  { command: "find . -exec rm {} \\;", minCategory: "destructive" },
  { command: "rm -rf build", minCategory: "destructive" },
  { command: "rm -r -f x", minCategory: "destructive" },
  { command: "rm --force y", minCategory: "destructive" },
  { command: "timeout 5 git push --force", minCategory: "destructive" },
  { command: "sudo rm -rf /", minCategory: "destructive" },
  { command: "dd if=/dev/zero of=/dev/sda", minCategory: "destructive" },
  { command: "git reset --hard", minCategory: "destructive" },
  { command: "git push --force-with-lease", minCategory: "destructive" },
  // ── executed-quoted forms: a dangerous token reaching a shell/interpreter runs ──
  { command: 'bash -c "rm -rf /"', minCategory: "destructive" },
  { command: '/bin/bash -c "rm -rf /"', minCategory: "destructive" },
  { command: 'echo "rm -rf /" | sh', minCategory: "destructive" },
  { command: 'echo "$(rm -rf /)"', minCategory: "destructive" },
  // these defeated a first-token-only eval check — the shell isn't the leading word:
  { command: 'echo hi\nbash -c "rm -rf /"', minCategory: "destructive" },
  { command: '{ bash -c "rm -rf /"; }', minCategory: "destructive" },
  { command: 'if true; then bash -c "rm -rf /"; fi', minCategory: "destructive" },
  { command: `perl -e 'system("rm -rf /")'`, minCategory: "destructive" },
  { command: `python3 -c 'import os; os.system("rm -rf /")'`, minCategory: "destructive" },
  { command: `awk 'BEGIN{system("rm -rf /")}'`, minCategory: "destructive" },
  // ── quoted-literal false positives that must NOT over-flag (non-eval command) ──
  { command: 'echo "rm -rf /"', minCategory: "read-only", exact: true },
  { command: "git commit -m 'rm -rf old build'", minCategory: "mutating", exact: true },
  // ── read-only controls: exact ──
  { command: "ls -la", minCategory: "read-only", exact: true },
  { command: "git status", minCategory: "read-only", exact: true },
  { command: "cat f", minCategory: "read-only", exact: true },
  // ── mutating controls: exact ──
  { command: "mkdir x", minCategory: "mutating", exact: true },
  { command: "mv a b", minCategory: "mutating", exact: true },
];
