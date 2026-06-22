/** Tool: sh_run — quiet, structured, addressable command execution. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { runWithRetry } from "../exec.js";
import { gitStatus, diffStatus, effectsFromTrace } from "../effects.js";
import { condense, lineCount } from "../render.js";
import { nextId, put } from "../store.js";
import { evaluate, type Expectation } from "../assert.js";
import { sandboxAvailable, wrapCommand, type SandboxOpts } from "../policy.js";
import { classify, looksInteractive } from "../classify.js";
import { traceAvailable, buildTraceCommand, summarizeTrace, type TraceSummary } from "../trace.js";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pathOrPaths = z.union([z.string(), z.array(z.string())]);

// The "destructive command ran unconfined" nudge fires at most ONCE per server
// process — a one-time hint, not per-command noise on routine `rm -rf build` calls.
let destructiveNudged = false;

const expectSchema = z
  .object({
    exit: z.number().int().optional().describe("require an exact exit code"),
    stdout_contains: z.string().optional().describe("stdout must contain this substring"),
    stdout_matches: z.string().optional().describe("stdout must match this regex"),
    stderr_empty: z.boolean().optional().describe("stderr must be empty (true) or non-empty (false)"),
    file_exists: pathOrPaths.optional().describe("path(s) that must exist after the run"),
    file_absent: pathOrPaths.optional().describe("path(s) that must NOT exist after the run"),
    changed: z.boolean().optional().describe("run must (true) or must not (false) change tracked files"),
    max_ms: z.number().positive().optional().describe("run must finish under this many ms"),
  })
  .optional()
  .describe("Post-conditions verified after the command, so you need no second command to confirm it worked.");

export function registerShRun(server: McpServer): void {
  server.registerTool(
    "sh_run",
    {
      title: "Run shell command (agent-native)",
      description:
        "Execute a shell command and return a QUIET, STRUCTURED result: exit code, " +
        "duration, files changed (git diff), and a token-aware view of stdout/stderr " +
        "(full on small/failure, head+tail otherwise). Full output is stored and " +
        "addressable via sh_detail — it is NOT re-emitted into context. Prefer this " +
        "over a raw Bash call when you care about effects or output is likely verbose.",
      inputSchema: {
        command: z.string().describe("The shell command to execute."),
        cwd: z.string().optional().describe("Working directory. Defaults to the server's cwd."),
        full: z
          .boolean()
          .optional()
          .describe("If true, return full stdout/stderr inline (skip condensing)."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Override per-command timeout in ms (0-config default applies otherwise)."),
        expect: expectSchema,
        retries: z.number().int().min(0).optional().describe("Retry up to N times on failure (default 0)."),
        retry_on_exit: z
          .array(z.number().int())
          .optional()
          .describe("Only retry when exit code is in this set; omit = retry on any nonzero."),
        backoff_ms: z.number().int().min(0).optional().describe("Fixed delay between retries in ms."),
        sandbox: z
          .union([
            z.boolean(),
            z.object({
              network: z.boolean().optional(),
              writable: z.array(z.string()).optional(),
            }),
          ])
          .optional()
          .describe(
            "Run under a real OS sandbox (macOS sandbox-exec): file writes confined to cwd + temp. " +
              "Pass {network:false} to also deny network, {writable:[...]} for extra writable paths. " +
              "REFUSES to run (does not execute unconfined) if a sandbox is unavailable.",
          ),
        trace: z
          .boolean()
          .optional()
          .describe(
            "Capture a structured FS/syscall trace (feature A; Linux strace). Surfaces a " +
              "read/write summary; full trace via sh_detail selector=trace. Best-effort: if no " +
              "tracer is available the command still runs and trace_unavailable is set.",
          ),
      },
    },
    async ({ command, cwd, full, timeout_ms, expect, retries, retry_on_exit, backoff_ms, sandbox, trace }) => {
      const workdir = cwd ?? process.cwd();

      // Feature K — real sandbox. Wrap the command for kernel-level confinement.
      // Honesty contract: if confinement is unavailable, refuse rather than run free.
      let toRun = command;
      let sandboxed = false;
      if (sandbox) {
        if (!sandboxAvailable()) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "sandbox requested but unavailable (needs macOS sandbox-exec); refusing to run unconfined",
                  sandbox_unavailable: true,
                }),
              },
            ],
            isError: true,
          };
        }
        try {
          toRun = wrapCommand(command, workdir, sandbox === true ? {} : (sandbox as SandboxOpts));
          sandboxed = true;
        } catch (e) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: String(e instanceof Error ? e.message : e) }) }],
            isError: true,
          };
        }
      }

      // Feature A — best-effort structured trace. Wrap OUTERMOST so the tracer
      // follows the (possibly sandboxed) command's forks. Observability, not safety:
      // degrade if no tracer rather than refusing.
      const preTraceCmd = toRun; // the (possibly sandboxed) command WITHOUT the tracer
      let traceDir: string | undefined;
      let traceUnavailable = false;
      if (trace) {
        if (traceAvailable()) {
          traceDir = mkdtempSync(join(tmpdir(), "veil-trace-"));
          const wrapped = buildTraceCommand(toRun, join(traceDir, "trace"));
          if (wrapped) {
            toRun = wrapped;
          } else {
            rmSync(traceDir, { recursive: true, force: true });
            traceDir = undefined;
            traceUnavailable = true;
          }
        } else {
          traceUnavailable = true;
        }
      }

      const cls = classify(command);
      // Effect-diff costs two `git status` calls. Skip them for a command we can
      // statically see is read-only, or when globally disabled (VEIL_EFFECTS=0,
      // for huge repos). A `changed` assertion always forces the diff so post-
      // conditions stay correct. A misclassified mutating command (rare, e.g.
      // `find -delete`) just won't show files_changed — consistent with best-effort.
      const trackEffects =
        expect?.changed !== undefined || (config.effects && cls.category !== "read-only");
      const retrySpec = { retries: retries ?? 0, retryOnExit: retry_on_exit, backoffMs: backoff_ms };
      // Effect source: when tracing, the trace IS the effect list — skip the two git
      // status calls entirely (cheaper than scanning the worktree, and more precise).
      const useTrace = traceDir !== undefined;
      const before = !useTrace && trackEffects ? gitStatus(workdir) : null;
      let res = await runWithRetry(toRun, workdir, timeout_ms ?? config.defaultTimeoutMs, retrySpec);

      // Trace reconciliation — BEFORE computing effects so files_changed reflects the
      // run that actually happened (including a re-run).
      let traceText: string | undefined;
      let traceSummary: TraceSummary | undefined;
      if (traceDir) {
        const tracePath = join(traceDir, "trace");
        if (existsSync(tracePath)) {
          // strace created its output → it initialized and exec'd the command, so
          // res.exit is the command's. Summarize (an empty trace is fine).
          try {
            traceText = readFileSync(tracePath, "utf8");
            traceSummary = summarizeTrace(traceText);
          } catch {
            traceUnavailable = true;
          }
        } else {
          // strace never created the file → it failed BEFORE exec → the command did
          // NOT run and res.exit is strace's, not the command's. Re-run untraced to
          // recover the true result — tracing must never change a command's outcome.
          // (No double-execution: an absent file means the command never ran.)
          res = await runWithRetry(preTraceCmd, workdir, timeout_ms ?? config.defaultTimeoutMs, retrySpec);
          traceUnavailable = true;
        }
        rmSync(traceDir, { recursive: true, force: true });
      }

      let filesChanged: string[] | null;
      if (useTrace) {
        // Trace ran → derive effects from what it actually wrote (cwd-scoped). If the
        // trace failed to capture, there are no git snapshots to fall back to → null.
        filesChanged = traceSummary ? effectsFromTrace(traceSummary.wrote, workdir) : null;
      } else {
        const after = trackEffects ? gitStatus(workdir) : null;
        filesChanged = diffStatus(before, after);
      }

      const id = nextId();
      put({
        id,
        command,
        cwd: workdir,
        exit: res.exit,
        durationMs: res.durationMs,
        timedOut: res.timedOut,
        stdoutTruncated: res.stdoutTruncated,
        stderrTruncated: res.stderrTruncated,
        stdoutBinary: res.stdoutBinary,
        stderrBinary: res.stderrBinary,
        attempts: res.attempts,
        stdout: res.stdout,
        stderr: res.stderr,
        filesChanged,
        trace: traceText,
      });

      const ok = res.exit === 0;
      // TRUE emitted line counts (not just retained bytes), so a truncated run's
      // size is reported honestly and the agent can judge whether to pull detail.
      const outLines = res.stdoutTotalLines;
      const errLines = res.stderrTotalLines;
      // Quiet contract: omit zero/default fields so tiny commands stay cheap.
      const result: Record<string, unknown> = { id, exit: res.exit, ok };
      result.ms = Math.round(res.durationMs);
      if (res.attempts > 1) result.attempts = res.attempts;
      // Line counts are meaningless for binary (NUL-byte) streams — omit them there.
      if (outLines && !res.stdoutBinary) result.stdout_lines = outLines;
      if (errLines && !res.stderrBinary) result.stderr_lines = errLines;
      // Only report file changes when there are some (and the dir is a git repo).
      if (filesChanged && filesChanged.length) result.files_changed = filesChanged;
      if (res.timedOut) result.timed_out = true;
      // Per-stream truncation: the agent must know WHICH stream lost data, since a
      // later sh_detail of the other stream is complete.
      if (res.stdoutTruncated) result.stdout_truncated = true;
      if (res.stderrTruncated) result.stderr_truncated = true;
      if (res.stdoutBinary) result.stdout_binary = true;
      if (res.stderrBinary) result.stderr_binary = true;
      if (sandboxed) result.sandboxed = true;
      if (traceSummary) result.trace_summary = traceSummary;
      if (traceUnavailable) result.trace_unavailable = true;

      // Feature G — post-conditions. Verify here so no second command is needed.
      let assertOk = true;
      if (expect) {
        const checks = evaluate(expect as Expectation, res, workdir, filesChanged);
        assertOk = checks.every((c) => c.pass);
        result.assert_ok = assertOk;
        // Only echo failing checks inline; passing ones are noise.
        const failed = checks.filter((c) => !c.pass);
        if (failed.length) {
          result.assertions_failed = failed.map((c) => (c.detail ? `${c.check} (${c.detail})` : c.check));
        }
      }

      if (full) {
        result.stdout = res.stdout;
        result.stderr = res.stderr;
      } else {
        // Binary streams are base64 in the store; condensing would mangle them and
        // they carry no line signal — flag instead of inlining.
        if (res.stdoutBinary) {
          // already surfaced via result.stdout_binary
        } else if (res.stdout.trim()) {
          result.stdout = condense(res.stdout, id, "stdout", { truncated: res.stdoutTruncated });
        }
        if (res.stderrBinary) {
          // already surfaced via result.stderr_binary
        } else if (res.stderr.trim()) {
          if (ok) {
            result.stderr = condense(res.stderr, id, "stderr", { truncated: res.stderrTruncated });
          } else {
            // Failure: show stderr whole up to the limit (count TRUE lines so the
            // boundary isn't off by one for a trailing newline). When the stderr
            // itself was truncated, banner it so the torn first line isn't read as
            // the root-cause start; condense() already banners on its own path.
            if (lineCount(res.stderr) <= config.stderrInlineOnFail) {
              const banner = res.stderrTruncated
                ? `… [stderr truncated at byte cap: earliest lines dropped, first line below may be a fragment — full via sh_detail id=${id} selector=stderr] …\n`
                : "";
              result.stderr = banner + res.stderr.trimEnd();
            } else {
              result.stderr = condense(res.stderr, id, "stderr", { truncated: res.stderrTruncated });
            }
          }
        }
      }

      if (!ok) {
        const why = res.timedOut ? `timed out` : `exit ${res.exit}`;
        result.hint = `Command failed (${why}). Full streams: sh_detail id=${id}.`;
      } else if (!assertOk) {
        result.hint = `Command exited 0 but post-conditions failed. Full streams: sh_detail id=${id}.`;
      }

      // Advisory (never blocks). Priority: a sandbox denial is the most actionable,
      // then nudging confinement for an unconfined destructive command, then warning
      // that an interactive/TTY command won't behave under buffered, TTY-less exec.
      if (sandboxed && !ok && /not permitted/i.test(res.stderr)) {
        result.advice = "sandbox denied an operation — add the path to sandbox.writable, set network:true, or run without sandbox";
      } else if (cls.category === "destructive" && !sandboxed && !destructiveNudged) {
        destructiveNudged = true; // once per process — don't nag on every rm
        result.advice = "destructive command ran unconfined — consider sandbox:true or sh_checkpoint to limit blast radius";
      } else if (looksInteractive(command)) {
        result.advice = "looks interactive/TTY-bound — sh_run buffers output and has no TTY; use raw Bash for interactive sessions";
      }

      // Compact JSON — the consumer is an LLM, not a human reader; bytes are tokens.
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
