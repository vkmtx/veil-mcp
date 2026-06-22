/**
 * Feature A — structured trace (lazy, best-effort).
 *
 * Applies the "effects as data" thesis at the SYSCALL level: instead of guessing a
 * command's file effects statically (classify) or diffing git after (effects), run
 * it under a tracer and report exactly which paths it READ and WROTE, plus a syscall
 * count. The full trace is stored addressably (sh_detail selector=trace); only a
 * compact summary is surfaced inline.
 *
 * CONTRACT — unlike the sandbox (safety: refuse if unavailable), tracing is
 * OBSERVABILITY: if no tracer is available it DEGRADES (the command still runs,
 * `trace_unavailable` is set) rather than refusing. Capture failures never fail the
 * command.
 *
 * Backends: Linux `strace -e trace=file`. macOS `dtruss` needs sudo + SIP relaxation
 * and so is treated as unavailable when unprivileged. The strace arg-builder and the
 * trace summarizer are unit-tested; live capture is validated on Linux (CI).
 */

import { execFileSync } from "node:child_process";

let cachedTracer: "strace" | null | undefined;

function computeTracer(): "strace" | null {
  if (process.platform === "linux") {
    try {
      // Real attach self-test (not just `-V`): if strace can't actually ptrace here
      // (restrictive yama/seccomp, no CAP_SYS_PTRACE, locked-down container), treat
      // it as ABSENT so tracing degrades cleanly — the command runs unwrapped — rather
      // than strace failing to init and corrupting the command's exit code.
      execFileSync("strace", ["-f", "-o", "/dev/null", "/bin/true"], { stdio: "ignore" });
      return "strace";
    } catch {
      return null;
    }
  }
  // macOS dtruss requires sudo + relaxed SIP — not usable unprivileged; treat as absent.
  return null;
}

/** Which tracer can we use on this platform, if any? Probed once per process. */
function tracerBin(): "strace" | null {
  if (cachedTracer === undefined) cachedTracer = computeTracer();
  return cachedTracer;
}

export function traceAvailable(): boolean {
  return tracerBin() !== null;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a command so a tracer records its file syscalls to `tracePath`. Returns the
 * wrapped shell command line, or null if no tracer is available (caller degrades).
 * `-f` follows forks so a shell pipeline / sandboxed child is traced too.
 */
export function buildTraceCommand(command: string, tracePath: string): string | null {
  if (tracerBin() !== "strace") return null;
  return `strace -f -e trace=file -o ${shQuote(tracePath)} /bin/sh -c ${shQuote(command)}`;
}

export interface TraceSummary {
  /** total traced syscall lines. */
  syscalls: number;
  /** distinct paths opened for writing (capped). */
  wrote: string[];
  /** distinct paths opened read-only (capped). */
  read: string[];
}

const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;

/**
 * Parse strace `-e trace=file` output into a structured read/write summary. Pure —
 * the testable core of feature A. Lines look like:
 *   openat(AT_FDCWD, "/path", O_WRONLY|O_CREAT, 0644) = 3
 */
export function summarizeTrace(text: string, cap = 200): TraceSummary {
  const wrote = new Set<string>();
  const read = new Set<string>();
  let syscalls = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    syscalls++;
    const m = line.match(/open(?:at)?\([^"]*"([^"]+)"\s*,\s*([^,)]+)/);
    if (!m) continue;
    const [, path, flags] = m;
    if (WRITE_FLAGS.test(flags)) wrote.add(path);
    else read.add(path);
  }
  return { syscalls, wrote: [...wrote].slice(0, cap), read: [...read].slice(0, cap) };
}
