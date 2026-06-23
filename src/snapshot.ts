/**
 * Feature C — checkpoint / rollback.
 *
 * A cheap working-tree safety net for an autonomous agent: snapshot a directory
 * before a risky operation, restore it if things go wrong. Implemented with rsync
 * mirroring into a temp store — no sudo, no filesystem-specific snapshots. This is
 * a pragmatic v0.2; a true atomic layer would use copy-on-write (APFS/btrfs/ZFS).
 *
 * Excludes .git and node_modules by default (large, reconstructible, or
 * separately versioned). Restore mirrors with --delete, so files created after the
 * checkpoint are removed — that is the point of a rollback.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const STORE = join(tmpdir(), "veil-checkpoints");
const PREVIEW_STORE = join(tmpdir(), "veil-previews");
// Origin sidecars live in a SEPARATE tree, not inside STORE — so they never
// collide with a payload dir (a label like `foo.dir` is otherwise ambiguous) and
// list() needs no filtering.
const META = join(tmpdir(), "veil-checkpoint-meta");
const EXCLUDES = ["--exclude", ".git", "--exclude", "node_modules"];

/** Sidecar recording the dir a checkpoint was taken from. */
function dirSidecar(label: string): string {
  return containedPath(META, label);
}

function safeLabel(label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new Error(`invalid checkpoint label: ${JSON.stringify(label)} (use [A-Za-z0-9._-])`);
  }
  // The charset above still admits the path-segment specials "." and ".." — a
  // bare ".." makes join(STORE, label) resolve to STORE's PARENT (the temp dir
  // itself), and the rmSync in checkpoint() would then recurse into it. Reject
  // them explicitly; multi-dot names like "..." are harmless literal dirs.
  if (label === "." || label === "..") {
    throw new Error(`invalid checkpoint label: ${JSON.stringify(label)} (reserved path segment)`);
  }
  return label;
}

/**
 * Resolve `label` under `base`, asserting the result stays strictly inside
 * `base`. Defense-in-depth: even if safeLabel is later loosened, no checkpoint
 * operation can ever touch a path outside its store. Used at every site that
 * joins an untrusted label onto STORE/META before an rmSync/rsync.
 */
function containedPath(base: string, label: string): string {
  safeLabel(label);
  const root = resolve(base);
  const p = resolve(base, label);
  if (!p.startsWith(root + sep)) {
    throw new Error(`checkpoint label escapes store: ${JSON.stringify(label)}`);
  }
  return p;
}

function ensureRsync(): void {
  try {
    execFileSync("rsync", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("rsync not found — required for checkpoint/restore");
  }
}

export interface CheckpointInfo {
  label: string;
  dir: string;
  path: string;
  /** how the snapshot was taken: "clone" (APFS copy-on-write) or "rsync" (byte copy). */
  method?: "clone" | "rsync";
}

const EXCLUDE_NAMES = [".git", "node_modules"];

/**
 * Feature C+ — try an APFS copy-on-write clone (`cp -c`): instant and space-free
 * on the same volume, the "atomic snapshot" the rsync mirror only approximated.
 * Returns true on success; false (leaving no partial dest) if clonefile isn't
 * possible (non-APFS, cross-volume, older macOS) so the caller falls back to rsync.
 */
function tryClone(dir: string, dest: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    // No dest beforehand → `cp -cR src dest` makes dest a CoW clone of src's tree.
    execFileSync("cp", ["-cR", dir, dest], { stdio: "ignore" });
    // Prune excludes from the CLONE only (cheap; the CoW source is untouched).
    for (const name of EXCLUDE_NAMES) rmSync(join(dest, name), { recursive: true, force: true });
    return true;
  } catch {
    rmSync(dest, { recursive: true, force: true }); // clean any partial clone
    return false;
  }
}

/** Device id of `p`, or -1 if it can't be stat'd. */
function devOf(p: string): number {
  try { return statSync(p).dev; } catch { return -1; }
}

/**
 * Decide the snapshot method from volume identity. An APFS clonefile (`cp -c`) is
 * real copy-on-write ONLY within one volume; across devices `cp -cR` silently
 * degrades to a full byte copy yet still exits 0 — which would mislabel a slow copy
 * as an instant "clone". STORE lives under tmpdir() (the macOS system APFS volume),
 * so a source on the SAME device is on that APFS volume and clones for real, while a
 * different device (USB, separate partition, RAM disk, non-APFS mount) must use the
 * rsync mirror and be reported honestly.
 */
export function chooseMethod(platform: NodeJS.Platform, srcDev: number, storeDev: number): "clone" | "rsync" {
  return platform === "darwin" && srcDev >= 0 && srcDev === storeDev ? "clone" : "rsync";
}

/** Snapshot `dir` under the given label. Overwrites an existing checkpoint of that label. */
export function checkpoint(label: string, dir: string): CheckpointInfo {
  ensureRsync();
  const dest = containedPath(STORE, label);
  if (!existsSync(dir)) throw new Error(`dir does not exist: ${dir}`);
  mkdirSync(STORE, { recursive: true });
  rmSync(dest, { recursive: true, force: true }); // fresh snapshot each time

  let method: "clone" | "rsync";
  // Only attempt a CoW clone when the source shares STORE's volume; otherwise cp -cR
  // would full-copy yet still report "clone". tryClone itself also returns false if
  // the clonefile fails (e.g. an older HFS+ volume), falling back to the rsync mirror.
  if (chooseMethod(process.platform, devOf(dir), devOf(STORE)) === "clone" && tryClone(dir, dest)) {
    method = "clone";
  } else {
    mkdirSync(dest, { recursive: true });
    // Trailing slash on source copies contents, not the dir itself.
    execFileSync("rsync", ["-a", "--delete", ...EXCLUDES, `${dir}/`, `${dest}/`], { stdio: "ignore" });
    method = "rsync";
  }

  mkdirSync(META, { recursive: true });
  writeFileSync(dirSidecar(label), resolve(dir)); // remember WHERE, to guard restore
  return { label, dir, path: dest, method };
}

/** Restore `dir` from a checkpoint, mirroring (files created since are removed). */
export function restore(label: string, dir: string): CheckpointInfo {
  ensureRsync();
  const src = containedPath(STORE, label);
  if (!existsSync(src)) throw new Error(`no checkpoint named ${label}`);
  // restore uses `rsync --delete`: pointing it at the WRONG dir would wipe that
  // dir down to the snapshot. Refuse unless the target matches where the
  // checkpoint was taken (legacy checkpoints without a sidecar are allowed).
  const sidecar = dirSidecar(label);
  if (existsSync(sidecar)) {
    const origin = readFileSync(sidecar, "utf8").trim();
    if (resolve(dir) !== origin) {
      throw new Error(
        `refusing to restore: checkpoint '${label}' was taken from ${origin}, not ${resolve(dir)} ` +
          `(rsync --delete would wipe the target). Recreate the checkpoint to retarget.`,
      );
    }
  }
  execFileSync("rsync", ["-a", "--delete", ...EXCLUDES, `${src}/`, `${dir}/`], { stdio: "ignore" });
  return { label, dir, path: src };
}

export interface PreviewClone {
  /** absolute path of the disposable clone the command will run inside. */
  path: string;
  method: "clone" | "rsync";
}

/**
 * Feature: dry-run preview. Make a FULL, disposable, runnable copy of `dir` (no
 * excludes — node_modules/.git are kept so builds and git commands work inside it)
 * under a fresh temp dir. APFS CoW (`cp -cR`) makes this instant + space-free on the
 * same volume; otherwise a full rsync byte-copy. The command then executes in the
 * clone and we diff clone-vs-origin, so the real cwd is never touched. Returns null
 * if the copy can't be made (caller must then refuse rather than run in the real cwd).
 */
export function cloneForPreview(dir: string): PreviewClone | null {
  if (!existsSync(dir)) return null;
  let base: string;
  try {
    mkdirSync(PREVIEW_STORE, { recursive: true });
    base = mkdtempSync(join(PREVIEW_STORE, "p-"));
  } catch {
    return null; // can't even make the temp parent → caller refuses
  }
  const dest = join(base, "tree");
  // CoW clone first (instant on APFS); keep ALL files (unlike checkpoint, which
  // prunes .git/node_modules) so the previewed command behaves like the real one.
  if (process.platform === "darwin") {
    try {
      execFileSync("cp", ["-cR", dir, dest], { stdio: "ignore" });
      return { path: dest, method: "clone" };
    } catch {
      rmSync(dest, { recursive: true, force: true });
    }
  }
  try {
    ensureRsync();
    mkdirSync(dest, { recursive: true });
    execFileSync("rsync", ["-a", `${dir}/`, `${dest}/`], { stdio: "ignore" });
    return { path: dest, method: "rsync" };
  } catch {
    rmSync(base, { recursive: true, force: true });
    return null;
  }
}

/** Remove a preview clone and its temp parent. Best-effort. */
export function dropPreview(clonePath: string): void {
  // clonePath is <PREVIEW_STORE>/p-XXXX/tree — drop the whole p-XXXX parent.
  const parent = resolve(clonePath, "..");
  if (parent.startsWith(PREVIEW_STORE)) rmSync(parent, { recursive: true, force: true });
  else rmSync(clonePath, { recursive: true, force: true });
}

/** List existing checkpoint labels. */
export function list(): string[] {
  if (!existsSync(STORE)) return [];
  return readdirSync(STORE);
}

/** Delete a checkpoint and its sidecar. */
export function drop(label: string): void {
  const p = containedPath(STORE, label);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  const sidecar = dirSidecar(label);
  if (existsSync(sidecar)) rmSync(sidecar, { force: true });
}
