/** Effects as data. File changes via git porcelain before/after diff. */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { resolveBin } from "./binpath.js";

/**
 * Canonical git top-level dir for cwd (`git rev-parse --show-toplevel`, realpath'd),
 * or null when cwd is not a git repo. This is the repo key used to serialize the
 * before/after effect-diff window so concurrent same-repo runs don't cross-attribute
 * each other's writes. Best-effort: any failure (not a repo, git missing) → null.
 */
export function gitToplevel(cwd: string): string | null {
  try {
    const top = execFileSync(resolveBin("git"), ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!top) return null;
    try {
      return realpathSync(top);
    } catch {
      return resolve(top);
    }
  } catch {
    return null; // not a git repo, or git unavailable
  }
}

/** Returns the set of porcelain status lines, or null if cwd is not a git repo. */
export function gitStatus(cwd: string): Set<string> | null {
  try {
    const out = execFileSync(resolveBin("git"), ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return null; // not a git repo, or git unavailable
  }
}

/**
 * Effects-as-data from a TRACE instead of git (syscall trace × effects-as-data). When a command ran
 * under a tracer we already know exactly which paths it wrote AND removed — derive
 * files_changed straight from that, scoped to `cwd`. This is cheaper than `git
 * status` (no worktree scan), more precise (catches untracked/ignored paths), and
 * lets sh_run skip the two git calls entirely when tracing. Paths are reported
 * cwd-relative as "wrote <rel>" / "deleted <rel>".
 */
export function effectsFromTrace(wrote: string[], deleted: string[], cwd: string): string[] {
  // strace records CANONICAL (realpath'd) paths, so match on the canonical cwd —
  // else a symlinked root (/tmp→/private/tmp, /var→/run, symlinked $HOME) drops real
  // in-cwd writes from files_changed. cloneDiff canonicalizes for the same reason.
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    root = resolve(cwd);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const emit = (verb: string, paths: string[]): void => {
    for (const p of paths) {
      const abs = resolve(root, p);
      if (abs !== root && !abs.startsWith(root + "/")) continue; // only effects under cwd
      const rel = relative(root, abs) || ".";
      const key = `${verb} ${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  };
  emit("wrote", wrote);
  emit("deleted", deleted);
  return out;
}

/**
 * Dry-run preview differ: list how a disposable clone diverged from the origin tree
 * after a command ran inside it. Uses `diff -rq` (excluding the VCS dir and
 * node_modules, both noisy and large) and parses its three line shapes into
 * cwd-relative change lines:
 *   - "Only in <clone>/sub: name"  → created <sub/name>
 *   - "Only in <origin>/sub: name" → deleted <sub/name>
 *   - "Files <origin>/x and <clone>/x differ" → modified <x>
 * Paths are reported relative to the clone root. This reflects cwd-RELATIVE writes
 * only; out-of-cwd / network effects are invisible here (the caller banners that).
 * HONEST tradeoff: node_modules is excluded for speed, so a previewed command that
 * writes UNDER node_modules (e.g. `npm install`) will NOT show those paths in
 * files_changed.
 */
export function cloneDiff(origin: string, clone: string): string[] {
  // Canonicalize so the prefix checks below match `diff`'s echoed paths even when
  // cwd/tmp is reached through a symlink (e.g. /tmp → /private/tmp on macOS).
  const canon = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const o = canon(origin);
  const c = canon(clone);
  let out = "";
  try {
    out = execFileSync(resolveBin("diff"), ["-rq", "--exclude=.git", "--exclude=node_modules", o, c], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // diff exits 1 when trees differ — that's the normal case, output is on stdout.
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1 && typeof err.stdout === "string") out = err.stdout;
    else return []; // exit 2 (real error) or no diff binary → nothing to report
  }
  const rel = (root: string, dir: string, name: string): string => {
    const r = relative(root, join(dir, name));
    return r || name;
  };
  const changes: string[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    let m = /^Only in (.+): (.+)$/.exec(line);
    if (m) {
      const [, dir, name] = m;
      // dir is an absolute path under either origin or clone.
      if (dir === c || dir.startsWith(c + "/")) changes.push(`created ${rel(c, dir, name)}`);
      else if (dir === o || dir.startsWith(o + "/")) changes.push(`deleted ${rel(o, dir, name)}`);
      continue;
    }
    // "Files <o>/REL and <c>/REL differ" — REL is identical on both sides and may
    // itself contain " and ", so anchor on the clone-root marker (a random temp path,
    // unambiguous) rather than a greedy ` and ` split that a filename could fool.
    if (line.startsWith("Files ") && line.endsWith(" differ")) {
      const body = line.slice("Files ".length, -" differ".length);
      const idx = body.indexOf(" and " + c + "/");
      if (idx >= 0) {
        const cloneAbs = body.slice(idx + " and ".length); // "<c>/REL"
        changes.push(`modified ${relative(c, cloneAbs) || cloneAbs}`);
      }
    }
  }
  return changes;
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
    // Otherwise: an untracked file that vanished was DELETED. A tracked change that
    // vanished is no longer dirty — but porcelain can't tell a `git add`/commit from
    // a real revert, so label it honestly rather than asserting "reverted".
    changed.push(t.startsWith("??") ? `deleted (untracked) ${porcelainPath(line)}` : `no longer dirty (committed or reverted): ${t}`);
  }
  return changed;
}
