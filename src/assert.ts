/**
 * Feature G — inline assertions / post-conditions.
 *
 * Lets one sh_run both execute AND verify, so the agent doesn't fire a second
 * command (ls / grep / git status) just to confirm the first worked. Each check
 * is evaluated after the command and reported as {check, pass}.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExecResult } from "./types.js";

export interface Expectation {
  /** require an exact exit code. */
  exit?: number;
  /** stdout must contain this substring. */
  stdout_contains?: string;
  /** stdout must match this regex (JS syntax, no flags). */
  stdout_matches?: string;
  /** stderr must be empty (whitespace-only counts as empty). */
  stderr_empty?: boolean;
  /** these path(s), relative to cwd, must exist after the run. */
  file_exists?: string | string[];
  /** these path(s), relative to cwd, must NOT exist after the run. */
  file_absent?: string | string[];
  /** whether the run must (true) or must not (false) have changed tracked files. */
  changed?: boolean;
  /** run must finish under this many milliseconds. */
  max_ms?: number;
}

export interface CheckResult {
  check: string;
  pass: boolean;
  detail?: string;
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function resolveIn(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

export function evaluate(
  exp: Expectation,
  res: ExecResult,
  cwd: string,
  filesChanged: string[] | null,
): CheckResult[] {
  const out: CheckResult[] = [];

  if (exp.exit !== undefined) {
    out.push({
      check: `exit == ${exp.exit}`,
      pass: res.exit === exp.exit,
      detail: res.exit === exp.exit ? undefined : `got ${res.exit}`,
    });
  }

  if (exp.stdout_contains !== undefined) {
    out.push({
      check: `stdout contains ${JSON.stringify(exp.stdout_contains)}`,
      pass: res.stdout.includes(exp.stdout_contains),
    });
  }

  if (exp.stdout_matches !== undefined) {
    let pass = false;
    let detail: string | undefined;
    try {
      pass = new RegExp(exp.stdout_matches).test(res.stdout);
    } catch (e) {
      detail = `invalid regex: ${String(e)}`;
    }
    out.push({ check: `stdout matches /${exp.stdout_matches}/`, pass, detail });
  }

  if (exp.stderr_empty !== undefined) {
    const empty = res.stderr.trim().length === 0;
    out.push({
      check: `stderr empty`,
      pass: exp.stderr_empty ? empty : !empty,
    });
  }

  for (const p of asArray(exp.file_exists)) {
    out.push({ check: `exists ${p}`, pass: existsSync(resolveIn(cwd, p)) });
  }

  for (const p of asArray(exp.file_absent)) {
    out.push({ check: `absent ${p}`, pass: !existsSync(resolveIn(cwd, p)) });
  }

  if (exp.changed !== undefined) {
    if (filesChanged === null) {
      out.push({ check: `changed == ${exp.changed}`, pass: false, detail: "not a git repo" });
    } else {
      const did = filesChanged.length > 0;
      out.push({ check: `changed == ${exp.changed}`, pass: did === exp.changed });
    }
  }

  if (exp.max_ms !== undefined) {
    out.push({
      check: `duration < ${exp.max_ms}ms`,
      pass: res.durationMs < exp.max_ms,
      detail: res.durationMs < exp.max_ms ? undefined : `took ${Math.round(res.durationMs)}ms`,
    });
  }

  return out;
}
