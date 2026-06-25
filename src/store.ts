/**
 * Addressable output store, disk-backed so sh_detail survives a restart.
 *
 * Records live in an in-memory cache (hot path) AND are persisted to a per-project
 * directory under the OS state location. A prior design kept records only in memory,
 * so restarting the MCP server — or a crash mid-session — lost the ability to
 * sh_detail every earlier run. Now a restart in the same project recovers them.
 *
 * Scoping & safety:
 *  - The store dir is namespaced by a hash of the server's working directory, so two
 *    projects never share records.
 *  - IDs are reserved by ATOMIC exclusive create of a `.lock` sidecar, so two servers
 *    in the same project never hand out the same `cmdN` (each just skips a taken slot).
 *  - A record is written to a temp file then atomically RENAMED into place, so a
 *    concurrent reader never observes a half-written/empty record file — a present
 *    `cmdN.json` is always a complete record.
 *  - Old records are pruned by TTL on boot and capped by VEIL_MAX_RECORDS (count)
 *    and VEIL_MAX_STORE_BYTES (total disk), evicting the OLDEST by mtime (not by id
 *    number, which is not a recency order across concurrent servers) — bounded disk,
 *    never the just-written record.
 *  - ALL disk I/O is best-effort: if the dir is not writable we degrade to
 *    memory-only and never fail a run. Set VEIL_STATE_DIR=none to force memory-only.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, renameSync, openSync, closeSync, chmodSync, existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import type { RunRecord } from "./types.js";

const records = new Map<string, RunRecord>();

/** Numeric suffix of a `cmdN` id or `cmdN.*` filename (0 if it doesn't match). */
function idNum(name: string): number {
  const m = /^cmd(\d+)\b/.exec(name);
  return m ? Number(m[1]) : 0;
}

/** Auto base dir: prefer XDG_STATE_HOME, then ~/.local/state, then the temp dir. */
function autoBase(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return join(xdg, "veil");
  const home = homedir();
  if (home) return join(home, ".local", "state", "veil");
  return join(tmpdir(), "veil");
}

/**
 * Resolve the per-project store dir, or null for memory-only. Returns null when
 * disk is explicitly disabled OR the dir can't be made writable — so a read-only
 * filesystem degrades gracefully instead of breaking sh_run.
 */
function resolveDir(): string | null {
  const raw = config.stateDir;
  if (raw && /^(none|off|memory|0)$/i.test(raw)) return null;
  const base = raw || autoBase();
  const proj = `proj-${createHash("sha1").update(process.cwd()).digest("hex").slice(0, 12)}`;
  const d = join(base, proj);
  try {
    // Records hold full stdout/stderr (possibly secrets in env-echoing output),
    // so the project store is OWNER-ONLY. mkdir's mode is umask-masked and skipped
    // for an already-existing dir, so chmod explicitly to enforce 0700 either way.
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try { chmodSync(d, 0o700); } catch { /* not owner / unsupported FS — best-effort */ }
    const probe = join(d, ".w");
    writeFileSync(probe, "", { mode: 0o600 });
    unlinkSync(probe);
    return d;
  } catch {
    return null;
  }
}

const dir = resolveDir();

function recordPath(id: string): string {
  return join(dir as string, `${id}.json`);
}
function lockPath(id: string): string {
  return join(dir as string, `${id}.json.lock`);
}

/** Highest existing `cmdN` (record OR in-flight lock) so a restart/second server
 *  continues strictly past it and never reuses a slot. */
function recoverCounter(): number {
  if (!dir) return 0;
  let max = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!/^cmd\d+\.json(\.lock)?$/.test(f)) continue;
      const n = idNum(f);
      if (n > max) max = n;
    }
  } catch {
    /* unreadable dir → start fresh */
  }
  return max;
}

/** Drop records (and stale locks/temps) older than the TTL, by mtime. Runs on boot. */
function pruneTTL(): void {
  if (!dir || config.recordTtlMs <= 0) return;
  const cutoff = Date.now() - config.recordTtlMs;
  try {
    for (const f of readdirSync(dir)) {
      if (!/^cmd\d+\.json(\.lock|\.tmp\..*)?$/.test(f)) continue;
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* concurrent removal / race — fine */
      }
    }
  } catch {
    /* unreadable dir — nothing to prune */
  }
}

if (dir) pruneTTL();
let counter = recoverCounter();

/**
 * Allocate the next id, reserving a `.lock` sidecar atomically (O_EXCL) so a
 * concurrent server in the same project can never hand out the same id — it just
 * finds the slot taken and moves on. The real record file is written later by put().
 */
export function nextId(): string {
  counter++;
  if (dir) {
    for (let guard = 0; guard < 100_000; guard++) {
      try {
        closeSync(openSync(lockPath(`cmd${counter}`), "wx", 0o600));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          counter++;
          continue;
        }
        // Other I/O error (disk full, perms): we can't reserve a lock. But never hand
        // back an id whose record file ALREADY exists — put()'s rename would clobber a
        // peer's record. Skip taken slots, then fall back to the un-reserved id.
        if (existsSync(recordPath(`cmd${counter}`))) {
          counter++;
          continue;
        }
        break; // fall back to in-memory id (record still cached)
      }
    }
  }
  return `cmd${counter}`;
}

/**
 * Cache a run record, and (by default) persist its full stdout/stderr to disk so
 * sh_detail survives a server restart.
 *
 * Pass `{ persist: false }` to keep a run MEMORY-ONLY: the record is set in the
 * in-memory cache (so sh_detail/sh_history still work for the rest of THIS session)
 * but NOTHING is written to disk — no temp file, no rename, no record file. This is
 * the per-run opt-out for a sensitive command (e.g. `env`, `cat .env`, `aws sts …`)
 * whose output would otherwise leave plaintext secrets at rest. The slot's
 * reservation lock (created by nextId) is removed best-effort so the id isn't leaked,
 * and the memory backstop in evict() still applies. Once the server exits, a
 * memory-only record is simply gone — it was never on disk.
 */
export function put(rec: RunRecord, opts?: { persist?: boolean }): void {
  records.set(rec.id, rec); // memory cache is set first, before any disk work
  if (opts?.persist === false) {
    // Memory-only: skip ALL disk writes. Drop the reservation lock so nextId's slot
    // isn't permanently leaked (best-effort — no lock on the mem-id fallback path).
    if (dir) {
      try { unlinkSync(lockPath(rec.id)); } catch { /* no lock / already gone */ }
    }
    evict();
    return;
  }
  if (dir) {
    try {
      // Write to a temp file then atomically rename into place, so a concurrent
      // reader never sees a partial/empty record. Then drop the reservation lock.
      const tmp = join(dir, `${rec.id}.json.tmp.${process.pid}`);
      writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 }); // rename preserves mode
      renameSync(tmp, recordPath(rec.id));
      try { unlinkSync(lockPath(rec.id)); } catch { /* no lock (mem-id path) */ }
    } catch {
      /* best-effort: a write failure must not break the command result */
    }
  }
  evict();
}

/** Enforce VEIL_MAX_RECORDS (by count) and VEIL_MAX_STORE_BYTES (by total size),
 *  evicting the OLDEST complete records by mtime until BOTH caps hold. Empty
 *  reservation locks are NOT counted, and the just-written record (newest mtime) is
 *  never the one evicted. */
function evict(): void {
  const capRecords = config.maxRecords > 0;
  const capBytes = config.maxStoreBytes > 0;
  if (dir && (capRecords || capBytes)) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => /^cmd\d+\.json$/.test(f));
    } catch {
      return;
    }
    // Single readdir+stat pass: capture both mtime and size for every record, and the
    // running total of bytes, so the count and byte caps work off one sorted list.
    let total = 0;
    const withTime = names.map((f) => {
      let mtime = 0, size = 0;
      try { const s = statSync(join(dir, f)); mtime = s.mtimeMs; size = s.size; } catch { /* gone */ }
      total += size;
      return { f, mtime, size };
    });
    withTime.sort((a, b) => a.mtime - b.mtime); // oldest first
    // Walk oldest-first, evicting until count ≤ maxRecords AND total ≤ maxStoreBytes.
    // Never touch the last (newest = just-written) entry, mirroring the count-only
    // invariant that the freshest record is always retained.
    let count = withTime.length;
    const lastIdx = withTime.length - 1;
    for (let i = 0; i < lastIdx; i++) {
      const overCount = capRecords && count > config.maxRecords;
      const overBytes = capBytes && total > config.maxStoreBytes;
      if (!overCount && !overBytes) break;
      const { f, size } = withTime[i];
      records.delete(f.slice(0, -5));
      try { unlinkSync(join(dir, f)); } catch { /* already gone */ }
      count--;
      total -= size;
    }
  }
  if (config.maxRecords <= 0) return;
  // Memory backstop — ALWAYS cap the in-memory Map, even with a disk store. Records
  // whose disk write failed (a flaky/again-read-only dir) are in `records` but not on
  // disk, so the disk evictor above never trims them and the Map would grow unbounded.
  // Trimming a still-on-disk entry is safe: get() re-reads from disk and re-caches.
  while (records.size > config.maxRecords) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
}

/**
 * All known run records, newest first by `at` (then id). Reads the memory cache AND
 * every cmdN.json on disk (de-duped by id, re-caching disk hits), so sh_history sees
 * runs from earlier sessions too. Best-effort: an unreadable/absent dir just yields
 * the in-memory set. Bounded by the same VEIL_MAX_RECORDS eviction as the store.
 */
export function all(): RunRecord[] {
  const byId = new Map<string, RunRecord>(records);
  if (dir) {
    try {
      for (const f of readdirSync(dir)) {
        if (!/^cmd\d+\.json$/.test(f)) continue;
        const id = f.slice(0, -5);
        if (byId.has(id)) continue;
        try {
          const raw = readFileSync(join(dir, f), "utf8");
          if (!raw) continue;
          const rec = JSON.parse(raw) as RunRecord;
          byId.set(id, rec);
          records.set(id, rec);
        } catch {
          /* partial/unparseable record — skip */
        }
      }
    } catch {
      /* unreadable dir — memory set only */
    }
  }
  return Array.from(byId.values()).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || idNum(b.id) - idNum(a.id));
}

export function get(id: string): RunRecord | undefined {
  const cached = records.get(id);
  if (cached) return cached;
  if (dir) {
    try {
      const raw = readFileSync(recordPath(id), "utf8");
      if (!raw) return undefined; // shouldn't happen (atomic rename), but be safe
      const rec = JSON.parse(raw) as RunRecord;
      records.set(id, rec); // re-cache after a disk hit
      return rec;
    } catch {
      return undefined; // missing / unparseable → unknown id
    }
  }
  return undefined;
}
