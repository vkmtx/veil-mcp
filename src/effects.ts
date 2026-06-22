/** Feature H — effects as data. File changes via git porcelain before/after diff. */

import { execSync } from "node:child_process";
import { resolve, relative } from "node:path";

/** Returns the set of porcelain status lines, or null if cwd is not a git repo. */
export function gitStatus(cwd: string): Set<string> | null {
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return null; // not a git repo, or git unavailable
  }
}

/**
 * Effects-as-data from a TRACE instead of git (feature A × H). When a command ran
 * under a tracer we already know exactly which paths it wrote — derive files_changed
 * straight from that, scoped to `cwd`. This is cheaper than `git status` (no
 * worktree scan), more precise (catches untracked/ignored paths), and lets sh_run
 * skip the two git calls entirely when tracing. Paths are reported cwd-relative.
 */
export function effectsFromTrace(wrote: string[], cwd: string): string[] {
  const root = resolve(cwd);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of wrote) {
    const abs = resolve(root, p);
    if (abs !== root && !abs.startsWith(root + "/")) continue; // only effects under cwd
    const rel = relative(root, abs) || ".";
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(`wrote ${rel}`);
  }
  return out;
}

/** Path from a porcelain line: `XY path`, or the new name from `XY old -> new`. */
function porcelainPath(line: string): string {
  const body = line.length > 3 ? line.slice(3) : line.trim();
  const arrow = body.indexOf(" -> ");
  return (arrow >= 0 ? body.slice(arrow + 4) : body).trim();
}

/**
 * Diff two porcelain snapshots into a list of human/agent-readable change lines.
 * Returns null if either side is unavailable (not a git repo).
 */
export function diffStatus(
  before: Set<string> | null,
  after: Set<string> | null,
): string[] | null {
  if (!before || !after) return null;
  const changed: string[] = [];
  const afterPaths = new Set(Array.from(after).map(porcelainPath));
  for (const line of after) if (!before.has(line)) changed.push(line.trim());
  for (const line of before) {
    if (after.has(line)) continue;
    // The SAME file still present in `after` under a different status (e.g. a dirty
    // file that got `git add`ed: " M f" -> "M  f") is a status transition, not a
    // revert/deletion — skip it so we don't emit a phantom "(reverted)".
    if (afterPaths.has(porcelainPath(line))) continue;
    const t = line.trim();
    // Otherwise: an untracked file that vanished was DELETED, not rolled back;
    // a tracked change that vanished was reverted.
    changed.push(t.startsWith("??") ? `deleted (untracked) ${porcelainPath(line)}` : `(reverted) ${t}`);
  }
  return changed;
}
