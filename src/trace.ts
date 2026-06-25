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
import { shQuote } from "./shquote.js";
import { resolveBin } from "./binpath.js";

let cachedTracer: "strace" | null | undefined;

function computeTracer(): "strace" | null {
  if (process.platform === "linux") {
    try {
      // Real attach self-test (not just `-V`): if strace can't actually ptrace here
      // (restrictive yama/seccomp, no CAP_SYS_PTRACE, locked-down container), treat
      // it as ABSENT so tracing degrades cleanly — the command runs unwrapped — rather
      // than strace failing to init and corrupting the command's exit code.
      execFileSync(resolveBin("strace"), ["-f", "-o", "/dev/null", "/bin/true"], { stdio: "ignore" });
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

/**
 * Wrap a command so a tracer records its file syscalls to `tracePath`. Returns the
 * wrapped shell command line, or null if no tracer is available (caller degrades).
 * `-f` follows forks so a shell pipeline / sandboxed child is traced too.
 */
export function buildTraceCommand(command: string, tracePath: string): string | null {
  if (tracerBin() !== "strace") return null;
  return `${resolveBin("strace")} -f -e trace=file -o ${shQuote(tracePath)} /bin/sh -c ${shQuote(command)}`;
}

export interface TraceSummary {
  /** total traced syscall lines. */
  syscalls: number;
  /** distinct paths opened for writing, plus rename destinations and created dirs (capped). */
  wrote: string[];
  /** distinct paths opened read-only (capped). */
  read: string[];
  /** distinct paths removed (unlink/rmdir) or moved-from (rename source), capped. */
  deleted: string[];
}

const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;

/**
 * Parse strace `-e trace=file` output into a structured read/write/delete summary.
 * Pure — the testable core of feature A. Lines look like:
 *   openat(AT_FDCWD, "/path", O_WRONLY|O_CREAT, 0644) = 3
 *   unlink("/path")                         = 0
 *   rename("/old", "/new")                  = 0
 *
 * Only SUCCESSFUL mutating syscalls (`= 0`, or `= <fd>` for open) are recorded; a
 * failed call (trailing `= -1 ENOENT`, etc.) changed nothing. Quote-grabbing matches
 * the open/openat style — up to the first closing quote — so it stays consistent and
 * doesn't try to decode strace's escaped-quote rendering.
 */
export function summarizeTrace(text: string, cap = 200): TraceSummary {
  const wrote = new Set<string>();
  const read = new Set<string>();
  const deleted = new Set<string>();
  let syscalls = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    syscalls++;

    const open = line.match(/open(?:at)?\([^"]*"([^"]+)"\s*,\s*([^,)]+)/);
    if (open) {
      const [, path, flags] = open;
      if (WRITE_FLAGS.test(flags)) wrote.add(path);
      else read.add(path);
      continue;
    }

    // Deletions: unlink("P")/unlinkat(AT_FDCWD,"P",…)/rmdir("P"), only when `= 0`.
    const del = line.match(/(?:unlink(?:at)?|rmdir)\([^"]*"([^"]+)"[^)]*\)\s*=\s*0\b/);
    if (del) {
      deleted.add(del[1]);
      continue;
    }

    // Renames: source moved-from (deleted), destination written. rename/renameat/
    // renameat2 all carry "OLD" then "NEW" as their first two quoted args.
    const ren = line.match(/rename(?:at2?|at)?\([^"]*"([^"]+)"[^"]*"([^"]+)"[^)]*\)\s*=\s*0\b/);
    if (ren) {
      deleted.add(ren[1]);
      wrote.add(ren[2]);
      continue;
    }

    // Directory creation counts as a write (a created path). mkdir/mkdirat, `= 0`.
    const mk = line.match(/mkdir(?:at)?\([^"]*"([^"]+)"[^)]*\)\s*=\s*0\b/);
    if (mk) {
      wrote.add(mk[1]);
      continue;
    }
  }
  return {
    syscalls,
    wrote: [...wrote].slice(0, cap),
    read: [...read].slice(0, cap),
    deleted: [...deleted].slice(0, cap),
  };
}
