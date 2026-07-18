/**
 * Live background-process registry.
 *
 * A normal sh_run blocks until the command finishes, which is wrong for a dev server
 * or a `--watch` build: those never exit, so the run just hangs until the timeout.
 * `background:true` spawns the command here instead, returns its id+pid immediately,
 * and keeps the live process in an in-memory Map so it can be polled (getLogs) and
 * stopped (kill) by id. When it eventually exits, its output is flushed to the durable
 * record store so the SAME id keeps resolving via sh_logs/sh_detail.
 *
 * Lifecycle invariant: an id always resolves to EITHER the live handle (while running /
 * just-exited) OR a durable RunRecord — never neither. On exit we put() the record
 * FIRST, then delete the live handle, so there is no gap where a poll would miss.
 *
 * Liveness: a background child must NOT keep the server's event loop alive. The MCP
 * stdio transport owns server liveness; a detached dev server outliving the agent would
 * wedge the process. So the child and its pipes are unref'd — the server can exit while
 * children run, and the shutdown coordinator (shutdown.ts) reaps them on the way out.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config.js";
import { BoundedBuffer, escalatingKill } from "./exec.js";
import { nextId, put, releaseId } from "./store.js";
import type { RunRecord } from "./types.js";

// "terminating" = an sh_kill signal was sent but the child hasn't closed yet — so we
// don't claim it's dead (or report an exit code) before the OS confirms it via 'close'.
export type BgStatus = "running" | "terminating" | "exited" | "killed";

interface BgHandle {
  id: string;
  /** the ORIGINAL command as the agent typed it (stored on the record; the spawned
   *  string may be sandbox-wrapped). */
  command: string;
  cwd: string;
  pid: number;
  child: ChildProcess;
  out: BoundedBuffer;
  err: BoundedBuffer;
  startedAt: bigint;
  at: number;
  status: BgStatus;
  /** terminating signal, once exited/killed by one. */
  signal?: string;
  /** whether this run's record should be persisted to disk on exit. */
  persist: boolean;
  /** signal the whole process group (negative pid), falling back to the lone child. */
  killTree: (sig: NodeJS.Signals) => void;
  /** canceller for a pending escalation SIGKILL, so a finished child doesn't get a
   *  stale SIGKILL on a recycled group. */
  cancelKill?: () => void;
}

/** id → live handle. Only LIVE processes live here; on exit the handle is removed and
 *  the run becomes addressable via the durable store. */
const registry = new Map<string, BgHandle>();

export interface StartResult {
  id: string;
  pid: number;
  status: BgStatus;
}

export interface StartError {
  error: string;
  /** set when the live-process cap (config.maxBgProcs) is already reached. */
  bg_limit_reached?: boolean;
}

/** A point-in-time view of a live (or just-exited) handle's logs for sh_logs. */
export interface LogsView {
  id: string;
  status: BgStatus;
  /** exit code once exited; undefined while still running. */
  exit?: number;
  signal?: string;
  /** wall-clock ms the process has been (or was) running. */
  running_ms: number;
  /** the requested stream slice(s) since the cursor, decoded as UTF-8. */
  stdout?: string;
  stderr?: string;
  /** new per-stream byte cursors to pass on the next poll (= each stream's
   *  totalBytesEver). Per-stream because stdout and stderr advance independently; a
   *  single shared offset would lose the shorter stream's output. */
  stdout_cursor: number;
  stderr_cursor: number;
  /** true if the cursor pointed before the retained window, so some bytes between the
   *  old cursor and the retained tail were dropped at the byte cap and not returned. */
  gap: boolean;
  stdout_lines: number;
  stderr_lines: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

/**
 * Spawn a command as a background process. `toRun` is the (possibly sandbox-wrapped)
 * command actually executed; `command` is the original for the record. Returns the
 * id+pid+status, or an error (e.g. the live cap is reached, or spawn never got a pid).
 */
export function startBackground(opts: {
  command: string;
  toRun: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  persist: boolean;
}): StartResult | StartError {
  // Enforce the live cap BEFORE spawning, so a refused run never forks a process.
  if (config.maxBgProcs > 0 && registry.size >= config.maxBgProcs) {
    return {
      error: `background process limit reached (${config.maxBgProcs} live); stop one with sh_kill or raise VEIL_MAX_BG_PROCS`,
      bg_limit_reached: true,
    };
  }

  const id = nextId();
  // detached:true → own process group, so killTree can signal the WHOLE tree (the
  // shell plus any grandchildren a dev server forks), exactly like runCommand.
  // stdin is /dev/null ("ignore"): the contract is "no stdin", and an open/inherited
  // stdin makes a child that reads it block instead of getting EOF. stdout/stderr piped.
  const child = spawn(opts.toRun, { cwd: opts.cwd, shell: true, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });

  const out = new BoundedBuffer(config.maxStreamBytes);
  const err = new BoundedBuffer(config.maxStreamBytes);
  child.stdout?.on("data", (d: Buffer) => out.push(d));
  child.stderr?.on("data", (d: Buffer) => err.push(d));

  // A background child must never hold the event loop open: the MCP stdio transport
  // owns server liveness. unref the child and its pipes so the server can exit while
  // the child runs (shutdown.ts reaps it). The pipe streams are Sockets at runtime
  // (unref exists) but typed as Readable (no unref), so call it through a narrow cast.
  child.unref();
  const unref = (s: unknown) => (s as { unref?: () => void } | null)?.unref?.();
  unref(child.stdout);
  unref(child.stderr);

  const killTree = (sig: NodeJS.Signals) => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig); // negative pid = the process group
    } catch {
      try {
        child.kill(sig); // group already gone; try the direct child
      } catch {
        /* already dead */
      }
    }
  };

  // The handle exists only once we know the spawn produced a pid; until then it stays
  // undefined and the listeners below no-op through reap()'s guard.
  let handle: BgHandle | undefined;

  /** Flush the handle to the durable store, then drop it from the live registry.
   *  put() FIRST so the id never has a window where it resolves to neither. No-op until
   *  the handle is registered (a pre-registration error/close just lands in the buffers). */
  const reap = (exit: number) => {
    if (!handle || !registry.has(id)) return; // not yet registered, or already reaped
    if (handle.cancelKill) handle.cancelKill();
    const durationMs = Number(process.hrtime.bigint() - handle.startedAt) / 1e6;
    const oBin = out.isBinary;
    const eBin = err.isBinary;
    const rec: RunRecord = {
      id,
      command: handle.command,
      cwd: handle.cwd,
      at: handle.at,
      exit,
      durationMs,
      timedOut: false, // background runs are never timeout-killed
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      stdoutBinary: oBin,
      stderrBinary: eBin,
      attempts: 1,
      stdout: oBin ? out.toBase64() : out.toString(),
      stderr: eBin ? err.toBase64() : err.toString(),
      // Total bytes ever emitted (incl. any dropped at the cap), so sh_logs can map a
      // live-phase byte cursor onto the durable record and return only NEW output after
      // the handoff instead of re-dumping the whole stream.
      stdoutBytesEver: out.totalBytesEver,
      stderrBytesEver: err.totalBytesEver,
      filesChanged: null,
      ...(handle.status === "killed" ? { killed: true } : {}),
      ...(handle.signal ? { signal: handle.signal } : {}),
    };
    put(rec, handle.persist ? undefined : { persist: false });
    registry.delete(id);
  };

  // Wire error/close listeners IMMEDIATELY after spawn — BEFORE the no-pid early-return.
  // An async spawn failure (a non-existent cwd, a missing shell binary) emits 'error' on
  // the next tick, and an 'error' event with NO listener crashes the whole MCP server.
  // Node emits these events asynchronously, so this synchronous setup (incl. registry.set
  // below) always completes first — no pre-registration race.
  child.on("close", (code, signal) => {
    if (handle) {
      if (signal) {
        handle.signal = signal;
        // A signalled close is a kill (an explicit sh_kill left status "terminating"; an
        // unsolicited signal caught the run "running"). Either way it settles as "killed".
        if (handle.status === "running" || handle.status === "terminating") handle.status = "killed";
      } else if (handle.status === "running") {
        handle.status = "exited";
      }
    }
    // Convention shared with runCommand: a signalled death has no numeric code.
    reap(signal ? 137 : code ?? -1);
  });

  child.on("error", (e) => {
    err.push(Buffer.from(String(e)));
    if (handle && handle.status === "running") handle.status = "exited";
    reap(-1);
  });

  if (child.pid === undefined) {
    // spawn produced no pid (missing shell binary, invalid cwd, …). The 'error' listener
    // above safely absorbs the async failure instead of crashing the server; release the
    // reserved id so the slot isn't leaked. Nothing else to track.
    releaseId(id);
    return { error: "failed to spawn background process (no pid)" };
  }

  handle = {
    id,
    command: opts.command,
    cwd: opts.cwd,
    pid: child.pid,
    child,
    out,
    err,
    startedAt: process.hrtime.bigint(),
    at: Date.now(),
    status: "running",
    persist: opts.persist,
    killTree,
  };
  // getLogs/kill/the shutdown reaper all resolve through this Map; without it the process
  // is spawned but untracked — orphaned on exit.
  registry.set(id, handle);

  return { id, pid: child.pid, status: "running" };
}

/** Byte length of `buf` excluding a trailing INCOMPLETE UTF-8 sequence, so slicing at the
 *  result never splits a multibyte codepoint across two polls. Scans back up to 3 bytes to
 *  the last sequence's lead byte and checks whether all its continuation bytes are present.
 */
function lastCompleteUtf8(buf: Buffer): number {
  const n = buf.length;
  for (let back = 1; back <= 3 && back <= n; back++) {
    const b = buf[n - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte — keep scanning back for the lead
    let expected: number;
    if ((b & 0x80) === 0) expected = 1; // 0xxxxxxx ASCII
    else if ((b & 0xe0) === 0xc0) expected = 2; // 110xxxxx
    else if ((b & 0xf0) === 0xe0) expected = 3; // 1110xxxx
    else if ((b & 0xf8) === 0xf0) expected = 4; // 11110xxx
    else expected = 1; // invalid lead — treat as a lone byte
    return back >= expected ? n : n - back; // complete → keep all; incomplete → hold back
  }
  return n; // all-continuation tail (or empty) — nothing safely holdable; emit as-is
}

/**
 * Logs for a live (or just-exited-but-still-live) handle since `cursor` bytes. Returns
 * null when the id is not live, so the caller falls back to the durable record via
 * store.get(id). The returned cursor is the stream's totalBytesEver, minus any incomplete
 * trailing UTF-8 held back — pass it back on the next poll to get only new output.
 */
export function getLogs(
  id: string,
  stdoutCursor: number | undefined,
  stderrCursor: number | undefined,
  stream: "stdout" | "stderr" | "both",
): LogsView | null {
  const h = registry.get(id);
  if (!h) return null;

  const running_ms = Number(process.hrtime.bigint() - h.startedAt) / 1e6;
  const view: LogsView = {
    id,
    status: h.status,
    running_ms,
    // Each stream's new cursor is its own totalBytesEver — advance independently.
    stdout_cursor: h.out.totalBytesEver,
    stderr_cursor: h.err.totalBytesEver,
    gap: false,
    stdout_lines: h.out.totalLines,
    stderr_lines: h.err.totalLines,
    stdout_truncated: h.out.truncated,
    stderr_truncated: h.err.truncated,
  };
  // Report an exit code only once the child has truly settled (exited/killed) — NOT while
  // "terminating" (an sh_kill was sent but 'close' hasn't fired yet), else we'd claim a
  // 137 before the process actually died.
  if (h.status === "exited" || h.status === "killed") {
    view.exit = h.signal ? 137 : 0; // best-effort; the durable record carries the exact code
    if (h.signal) view.signal = h.signal;
  }

  // Slice a stream from its OWN byte cursor, decoding on the EXACT raw byte range
  // (rawSlice) so text isn't corrupted by a lossy decode/re-encode round-trip and BINARY
  // honors the cursor too (base64 of only the new bytes — decode each poll, then concat;
  // do NOT concat the base64 strings). For text, hold back an incomplete trailing multibyte
  // sequence so a codepoint is never split across polls, rewinding the returned cursor by
  // the held-back bytes so the next poll re-reads them whole. A cursor before the retained
  // window (bytes dropped at the cap) flags a gap. Cursors are PER-STREAM.
  const sliceOf = (buf: BoundedBuffer, from: number): { text: string; gap: boolean; cursor: number } => {
    const ever = buf.totalBytesEver;
    const gap = from < ever - buf.retainedBytes;
    const raw = buf.rawSlice(from);
    if (buf.isBinary) return { text: raw.toString("base64"), gap, cursor: ever };
    const whole = lastCompleteUtf8(raw);
    return { text: raw.subarray(0, whole).toString("utf8"), gap, cursor: ever - (raw.length - whole) };
  };

  let gap = false;
  if (stream === "stdout" || stream === "both") {
    const s = sliceOf(h.out, stdoutCursor ?? 0);
    view.stdout = s.text;
    view.stdout_cursor = s.cursor;
    gap = gap || s.gap;
  }
  if (stream === "stderr" || stream === "both") {
    const s = sliceOf(h.err, stderrCursor ?? 0);
    view.stderr = s.text;
    view.stderr_cursor = s.cursor;
    gap = gap || s.gap;
  }
  view.gap = gap;
  return view;
}

export interface KillResult {
  id: string;
  status: "terminating" | "not_live";
  signal?: string;
}

/**
 * Signal a live background process. SIGTERM uses the 2s SIGTERM→SIGKILL escalation
 * (so a child that ignores SIGTERM is still reaped); other signals are sent once.
 * Returns status:"terminating" when a live process was SIGNALLED — the process is not yet
 * confirmed dead; it settles to exited/killed only when the OS delivers 'close' (poll
 * sh_logs to observe that). Returns "not_live" when the id is not in the registry (the
 * caller treats that as an idempotent already_exited if a record exists, else unknown id).
 */
export function kill(id: string, signal: NodeJS.Signals): KillResult {
  const h = registry.get(id);
  if (!h) return { id, status: "not_live" };
  // "terminating", NOT "killed": the signal is only SENT here; the child is reaped and
  // marked killed by the 'close' handler once the OS actually tears it down.
  h.status = "terminating";
  h.signal = signal;
  if (signal === "SIGTERM") {
    // Cancel any prior escalation before starting a new one (repeated sh_kill).
    if (h.cancelKill) h.cancelKill();
    h.cancelKill = escalatingKill(h.killTree);
  } else {
    h.killTree(signal);
  }
  return { id, status: "terminating", signal };
}

/** All live handles (for the shutdown coordinator). */
export function liveHandles(): { id: string; pid: number; killTree: (sig: NodeJS.Signals) => void }[] {
  return Array.from(registry.values()).map((h) => ({ id: h.id, pid: h.pid, killTree: h.killTree }));
}

/** Number of currently-live background processes. */
export function liveCount(): number {
  return registry.size;
}

/** SIGTERM (or the given signal) every live handle — first step of graceful shutdown. */
export function killAllLive(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const h of registry.values()) {
    h.status = "killed";
    h.signal = signal;
    h.killTree(signal);
  }
}
