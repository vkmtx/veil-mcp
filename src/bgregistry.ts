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

export type BgStatus = "running" | "exited" | "killed";

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
  const child = spawn(opts.toRun, { cwd: opts.cwd, shell: true, env: opts.env, detached: true });

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
        // A signalled close that wasn't an explicit sh_kill is still a kill, not a clean
        // exit — mark it so unless we already recorded the kill.
        if (handle.status === "running") handle.status = "killed";
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

/**
 * Logs for a live (or just-exited-but-still-live) handle since `cursor` bytes. Returns
 * null when the id is not live, so the caller falls back to the durable record via
 * store.get(id). The returned cursor is the stream's totalBytesEver — pass it back on
 * the next poll to get only new output.
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
  if (h.status !== "running") {
    view.exit = h.signal ? 137 : 0; // best-effort; the durable record carries the exact code
    if (h.signal) view.signal = h.signal;
  }

  // Slice a stream from its OWN byte cursor to its current end. The retained window is
  // the LAST retainedBytes of the totalBytesEver stream, so the available slice starts
  // at (totalBytesEver - retainedBytes); a cursor before that means bytes were dropped
  // at the byte cap → gap. Cursors are PER-STREAM: a single shared offset would lose
  // the shorter stream's new output once the longer stream pulled the cursor past it.
  const sliceOf = (buf: BoundedBuffer, from: number): { text: string; gap: boolean } => {
    const ever = buf.totalBytesEver;
    const retainedStart = ever - buf.retainedBytes;
    const gap = from < retainedStart;
    if (buf.isBinary) return { text: buf.toBase64(), gap };
    const effectiveStart = Math.max(from, retainedStart);
    const dropBytes = effectiveStart - retainedStart;
    const retained = Buffer.from(buf.toString(), "utf8");
    const text = retained.subarray(Math.min(dropBytes, retained.length)).toString("utf8");
    return { text, gap };
  };

  let gap = false;
  if (stream === "stdout" || stream === "both") {
    const s = sliceOf(h.out, stdoutCursor ?? 0);
    view.stdout = s.text;
    gap = gap || s.gap;
  }
  if (stream === "stderr" || stream === "both") {
    const s = sliceOf(h.err, stderrCursor ?? 0);
    view.stderr = s.text;
    gap = gap || s.gap;
  }
  view.gap = gap;
  return view;
}

export interface KillResult {
  id: string;
  status: "killed" | "not_live";
  signal?: string;
}

/**
 * Signal a live background process. SIGTERM uses the 2s SIGTERM→SIGKILL escalation
 * (so a child that ignores SIGTERM is still reaped); other signals are sent once.
 * Returns status:"killed" when a live process was signalled, "not_live" when the id is
 * not in the registry (the caller treats that as an idempotent already_exited if a
 * record exists, else an unknown id).
 */
export function kill(id: string, signal: NodeJS.Signals): KillResult {
  const h = registry.get(id);
  if (!h) return { id, status: "not_live" };
  h.status = "killed";
  h.signal = signal;
  if (signal === "SIGTERM") {
    // Cancel any prior escalation before starting a new one (repeated sh_kill).
    if (h.cancelKill) h.cancelKill();
    h.cancelKill = escalatingKill(h.killTree);
  } else {
    h.killTree(signal);
  }
  return { id, status: "killed", signal };
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
