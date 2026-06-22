/** Command execution with timeout + bounded output buffering. */

import { spawn } from "node:child_process";
import { config } from "./config.js";
import type { ExecResult } from "./types.js";

/** Accumulates a stream while enforcing a byte cap (keeps the tail, drops oldest). */
class BoundedBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  /** newline bytes seen across the WHOLE stream, even those later dropped. */
  private newlines = 0;
  private sawBytes = false;
  /** last byte pushed, to know whether the stream ended on a newline. */
  private lastByte = -1;
  /** true if any NUL byte was seen — a reliable binary-content signal. */
  private nul = false;
  truncated = false;
  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.sawBytes = true;
    // Count newlines (and detect NUL) on the way in, so the TRUE line count
    // survives even when older chunks are dropped at the byte cap below.
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (b === 0x0a) this.newlines++;
      else if (b === 0x00) this.nul = true;
    }
    this.lastByte = chunk[chunk.length - 1];
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.cap > 0 && this.bytes > this.cap) {
      this.truncated = true;
      // Drop from the front until under cap. Keep the most recent output —
      // for a failing build the tail (the error) matters more than the head.
      while (this.bytes > this.cap && this.chunks.length > 1) {
        const dropped = this.chunks.shift()!;
        this.bytes -= dropped.length;
      }
    }
  }

  private view(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Retained tail decoded as UTF-8. Lossy for binary — use base64 then. */
  toString(): string {
    return this.view().toString("utf8");
  }

  /** Retained tail as base64 — lossless, for binary streams. */
  toBase64(): string {
    return this.view().toString("base64");
  }

  get isBinary(): boolean {
    return this.nul;
  }

  /** True emitted line count for the whole stream (final line without \n still counts). */
  get totalLines(): number {
    if (!this.sawBytes) return 0;
    return this.newlines + (this.lastByte === 0x0a ? 0 : 1);
  }
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number = config.defaultTimeoutMs,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    // detached:true puts the shell in its own process group so we can signal the
    // WHOLE tree, not just the shell. With shell:true the immediate child is the
    // shell; a compound command (`sleep 5; echo`) forks grandchildren that the
    // shell does NOT exec into, so killing the shell alone orphans them — they keep
    // the stdout pipe open and the run blocks until they exit, defeating the
    // timeout. Killing the process group (negative pid) reaps the grandchildren too.
    const child = spawn(command, { cwd, shell: true, env: process.env, detached: true });

    const out = new BoundedBuffer(config.maxStreamBytes);
    const err = new BoundedBuffer(config.maxStreamBytes);
    let timedOut = false;
    let settled = false;

    /** Signal the child's whole process group; fall back to the lone child. */
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

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree("SIGTERM");
            // Hard kill if it ignores SIGTERM.
            setTimeout(() => killTree("SIGKILL"), 2000).unref();
          }, timeoutMs)
        : null;

    const finish = (exit: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const oBin = out.isBinary;
      const eBin = err.isBinary;
      resolve({
        exit,
        // Binary streams are stored base64 (lossless); text decodes to UTF-8.
        stdout: oBin ? out.toBase64() : out.toString(),
        stderr: eBin ? err.toBase64() : err.toString(),
        durationMs,
        timedOut,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        stdoutTotalLines: out.totalLines,
        stderrTotalLines: err.totalLines,
        stdoutBinary: oBin,
        stderrBinary: eBin,
      });
    };

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("close", (code) => finish(timedOut ? 124 : code ?? -1));
    child.on("error", (e) => {
      err.push(Buffer.from(String(e)));
      finish(-1);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetrySpec {
  /** max extra attempts after the first (0 = run once). */
  retries: number;
  /** retry only when the exit code is in this set; empty = any nonzero exit. */
  retryOnExit?: number[];
  /** delay between attempts in ms (fixed). */
  backoffMs?: number;
}

export interface RetryResult extends ExecResult {
  /** total attempts made (1 = no retry happened). */
  attempts: number;
}

/** Run a command, retrying on failure per spec. Returns the last attempt + count. */
export async function runWithRetry(
  command: string,
  cwd: string,
  timeoutMs: number,
  spec: RetrySpec,
): Promise<RetryResult> {
  const maxAttempts = Math.max(1, spec.retries + 1);
  let last!: ExecResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await runCommand(command, cwd, timeoutMs);
    const failed = last.exit !== 0;
    const retryable =
      !spec.retryOnExit || spec.retryOnExit.length === 0
        ? failed
        : spec.retryOnExit.includes(last.exit);
    if (!failed || !retryable || attempt === maxAttempts) {
      return { ...last, attempts: attempt };
    }
    if (spec.backoffMs && spec.backoffMs > 0) await sleep(spec.backoffMs);
  }
  return { ...last, attempts: maxAttempts };
}
