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
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STORE = join(tmpdir(), "veil-checkpoints");
// Origin sidecars live in a SEPARATE tree, not inside STORE — so they never
// collide with a payload dir (a label like `foo.dir` is otherwise ambiguous) and
// list() needs no filtering.
const META = join(tmpdir(), "veil-checkpoint-meta");
const EXCLUDES = ["--exclude", ".git", "--exclude", "node_modules"];

/** Sidecar recording the dir a checkpoint was taken from. */
function dirSidecar(label: string): string {
  return join(META, label);
}

function safeLabel(label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new Error(`invalid checkpoint label: ${JSON.stringify(label)} (use [A-Za-z0-9._-])`);
  }
  return label;
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

/** Snapshot `dir` under the given label. Overwrites an existing checkpoint of that label. */
export function checkpoint(label: string, dir: string): CheckpointInfo {
  ensureRsync();
  safeLabel(label);
  if (!existsSync(dir)) throw new Error(`dir does not exist: ${dir}`);
  const dest = join(STORE, label);
  mkdirSync(STORE, { recursive: true });
  rmSync(dest, { recursive: true, force: true }); // fresh snapshot each time

  let method: "clone" | "rsync";
  if (tryClone(dir, dest)) {
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
  safeLabel(label);
  const src = join(STORE, label);
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

/** List existing checkpoint labels. */
export function list(): string[] {
  if (!existsSync(STORE)) return [];
  return readdirSync(STORE);
}

/** Delete a checkpoint and its sidecar. */
export function drop(label: string): void {
  safeLabel(label);
  const p = join(STORE, label);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  const sidecar = dirSidecar(label);
  if (existsSync(sidecar)) rmSync(sidecar, { force: true });
}
