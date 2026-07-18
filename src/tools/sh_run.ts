/** Tool: sh_run — quiet, structured, addressable command execution. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { runWithRetry } from "../exec.js";
import { startBackground } from "../bgregistry.js";
import { gitStatus, gitToplevel, diffStatus, effectsFromTrace, cloneDiff } from "../effects.js";
import { withRepoLock } from "../repolock.js";
import { condense, lineCount } from "../render.js";
import { nextId, put } from "../store.js";
import { evaluate, type Expectation } from "../assert.js";
import { sandboxAvailable, wrapCommand, defaultSecretPaths, scrubSecretEnv, type SandboxOpts } from "../policy.js";
import { cloneForPreview, dropPreview, type PreviewClone } from "../snapshot.js";
import { classify, looksInteractive } from "../classify.js";
import { traceAvailable, buildTraceCommand, summarizeTrace, type TraceSummary } from "../trace.js";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const pathOrPaths = z.union([z.string(), z.array(z.string())]);

/** Canonical (symlink-free) absolute path, falling back to a plain resolve. Used as
 *  the repo-lock key when a workdir isn't a git repo, so the same dir reached via a
 *  symlink still maps to one lock. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Expand a leading `~`/`~/` to $HOME so secret paths can be given tilde-style. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Partition requested secret paths into the DIRECTORIES we can actually read-confine
 * and the existing FILES we cannot (the Linux `--tmpfs` mask needs a dir; the v1
 * backend is dir-only). A missing path is silently ignored — there is nothing to
 * protect. But an existing FILE that was requested is a real protection the backend
 * can't deliver, so it is returned for DISCLOSURE rather than dropped silently — a
 * `secrets_protected` count must never imply a named secret is safe when it isn't.
 */
function partitionSecrets(paths: string[]): { dirs: string[]; droppedFiles: string[] } {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const droppedFiles: string[] = [];
  for (const raw of paths) {
    const p = expandTilde(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue; // missing path — nothing to protect
    }
    if (isDir) dirs.push(p);
    else droppedFiles.push(p); // exists but not a dir → backend can't mask it
  }
  return { dirs, droppedFiles };
}

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
        "over a raw Bash call when you care about effects or output is likely verbose. " +
        "Pass scrub_env:true to strip credential-shaped env vars from the child (auto-on " +
        "with sandbox protect_secrets/deny_read); no_store:true keeps a sensitive run memory-only.",
      inputSchema: {
        // Corrective -32602: when `command` is missing (sent under a wrong key —
        // the SDK validates BEFORE the handler and zod strips unknown keys, so a
        // handler-side normalizer can never see it), teach the minimal call shape
        // in-band instead of dumping the raw zod error.
        command: z
          .string({
            error: (iss) =>
              iss.input === undefined
                ? 'missing required "command" (string). Minimal call: {"command":"<shell command>"}. Optional: expect, cwd, sandbox, timeout_ms, retries, background via `&` is NOT supported — use Bash for dev servers/TTY.'
                : undefined,
          })
          .describe("The shell command to execute."),
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
              protect_secrets: z
                .boolean()
                .optional()
                .describe("Also block reads of a built-in secret-dir denylist (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gcloud|gh, ~/.kube, ~/.docker)."),
              deny_read: z
                .array(z.string())
                .optional()
                .describe("Extra existing DIRECTORIES whose reads are blocked under the sandbox (tilde ok)."),
            }),
          ])
          .optional()
          .describe(
            "Run under a real OS sandbox (macOS sandbox-exec / Linux bubblewrap): file writes confined to cwd + temp. " +
              "Pass {network:false} to deny network, {writable:[...]} for extra writable paths, " +
              "{protect_secrets:true} or {deny_read:[...]} to BLOCK READS of configured secret dirs (scoped — " +
              "blocks the listed paths, NOT a proof against all exfiltration). " +
              "REFUSES to run (does not execute unconfined) if a sandbox is unavailable.",
          ),
        preview: z
          .boolean()
          .optional()
          .describe(
            "Dry-run in a disposable CoW clone of cwd: the command runs INSIDE the clone, you get the " +
              "cwd-relative file diff, and the real cwd is never touched (nothing is promoted). " +
              "Honest scope: absolute-path / parent-dir / network effects are NOT captured and may happen for " +
              "real — this is NOT a sandbox (combine with sandbox:true for containment). Refuses if cwd can't be cloned.",
          ),
        trace: z
          .boolean()
          .optional()
          .describe(
            "Capture a structured FS/syscall trace (Linux strace). Surfaces a " +
              "read/write summary; full trace via sh_detail selector=trace. Best-effort: if no " +
              "tracer is available the command still runs and trace_unavailable is set.",
          ),
        scrub_env: z
          .boolean()
          .optional()
          .describe(
            "Strip credential-shaped vars (SECRET/TOKEN/PASSWORD/KEY/… see SECRET_ENV_PATTERNS) " +
              "from the command's environment so a child can't read them. Auto-enabled whenever the " +
              "sandbox requests protect_secrets or deny_read — masking ~/.ssh while leaving tokens in " +
              "$env would be inconsistent. Surfaces secrets_env_scrubbed (a COUNT; values are never echoed).",
          ),
        no_store: z
          .boolean()
          .optional()
          .describe(
            "Keep this run MEMORY-ONLY: the record is cached for sh_detail this session but is NOT " +
              "written to disk. Use for a sensitive run whose output should not persist. Result carries " +
              "stored:\"memory-only\" so you know sh_detail works now but nothing was persisted.",
          ),
        background: z
          .boolean()
          .optional()
          .describe(
            "Run as a LONG-RUNNING background process (dev server, --watch build): returns IMMEDIATELY " +
              "with { id, pid, status:\"running\" } instead of blocking until exit. Poll its output with " +
              "sh_logs id=<id> (pass the returned cursor to tail only new lines); stop it with sh_kill id=<id>. " +
              "No stdin/TTY. Incompatible with options that require completion (expect, preview, trace, retries, " +
              "full, timeout_ms) — those are refused. Keeps cwd, sandbox, scrub_env, no_store.",
          ),
      },
    },
    async ({ command, cwd, full, timeout_ms, expect, retries, retry_on_exit, backoff_ms, sandbox, trace, preview, scrub_env, no_store, background }) => {
      const origin = cwd ?? process.cwd();
      let workdir = origin;

      // Background branch — handled EARLY, before the effect-window / preview / trace
      // machinery, because those all depend on the command COMPLETING. A background run
      // returns immediately, so any option that requires completion is incompatible and
      // refused (rather than silently ignored). It keeps cwd, sandbox (a confined dev
      // server is valuable), scrub_env, and no_store.
      if (background) {
        const incompatible: string[] = [];
        if (expect) incompatible.push("expect");
        if (preview) incompatible.push("preview");
        if (trace) incompatible.push("trace");
        if (retries) incompatible.push("retries");
        if (retry_on_exit) incompatible.push("retry_on_exit");
        if (backoff_ms) incompatible.push("backoff_ms");
        if (full) incompatible.push("full");
        if (timeout_ms !== undefined) incompatible.push("timeout_ms");
        if (incompatible.length) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `background runs return immediately, so these options (which require the command to complete) are not supported: ${incompatible.join(", ")}`,
                  background_incompatible: incompatible,
                }),
              },
            ],
            isError: true,
          };
        }

        // Wrap for the sandbox exactly like the foreground path — a confined dev server
        // is a real win. Honesty contract preserved: refuse rather than run unconfined.
        let bgToRun = command;
        let bgSandboxed = false;
        let bgSecretsProtected = 0;
        let bgSecretsUnprotected: string[] = [];
        let bgProtectsSecrets = false;
        if (sandbox) {
          if (!sandboxAvailable()) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: "sandbox requested but unavailable (needs macOS sandbox-exec, or Linux bubblewrap / Landlock-landrun); refusing to run unconfined",
                    sandbox_unavailable: true,
                  }),
                },
              ],
              isError: true,
            };
          }
          try {
            const raw =
              sandbox === true
                ? {}
                : (sandbox as { network?: boolean; writable?: string[]; protect_secrets?: boolean; deny_read?: string[] });
            bgProtectsSecrets = !!raw.protect_secrets || !!(raw.deny_read && raw.deny_read.length);
            const { dirs: denyRead, droppedFiles } = partitionSecrets([
              ...(raw.protect_secrets ? defaultSecretPaths() : []),
              ...(raw.deny_read ?? []),
            ]);
            const sbOpts: SandboxOpts = { network: raw.network, writable: raw.writable };
            if (denyRead.length) sbOpts.denyRead = denyRead;
            bgToRun = wrapCommand(command, origin, sbOpts);
            bgSandboxed = true;
            bgSecretsProtected = denyRead.length;
            bgSecretsUnprotected = droppedFiles;
          } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            const unsupported = /landlock backend cannot enforce/i.test(msg);
            return {
              content: [{ type: "text", text: JSON.stringify({ error: msg, ...(unsupported ? { sandbox_unsupported_feature: true } : {}) }) }],
              isError: true,
            };
          }
        }

        // scrub credential-shaped env vars (explicit, or implied by secret protection),
        // mirroring the foreground path so a backgrounded child is no leakier.
        const bgScrub = scrub_env || bgProtectsSecrets;
        let bgEnv: NodeJS.ProcessEnv = process.env;
        let bgEnvScrubbed = 0;
        if (bgScrub) {
          const { env: scrubbedEnv, scrubbed } = scrubSecretEnv(process.env);
          bgEnv = scrubbedEnv;
          bgEnvScrubbed = scrubbed.length;
        }

        const started = startBackground({
          command,
          toRun: bgToRun,
          cwd: origin,
          env: bgEnv,
          persist: !no_store,
        });
        if ("error" in started) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: started.error,
                  ...(started.bg_limit_reached ? { bg_limit_reached: true } : {}),
                }),
              },
            ],
            isError: true,
          };
        }

        const result: Record<string, unknown> = {
          id: started.id,
          pid: started.pid,
          status: "running",
          background: true,
          hint: `Background process started. Poll output: sh_logs id=${started.id}. Stop: sh_kill id=${started.id}.`,
        };
        if (bgSandboxed) result.sandboxed = true;
        if (bgSecretsProtected) result.secrets_protected = bgSecretsProtected;
        if (bgSecretsUnprotected.length) result.secrets_unprotected = bgSecretsUnprotected;
        if (bgEnvScrubbed) result.secrets_env_scrubbed = bgEnvScrubbed;
        if (no_store) result.stored = "memory-only";
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      // Dry-run preview — clone cwd and run INSIDE the clone so the real cwd is never
      // touched. Honesty contract: if the clone can't be made, REFUSE — never silently
      // fall back to running in the real cwd.
      let previewClone: PreviewClone | null = null;
      if (preview) {
        previewClone = cloneForPreview(origin);
        if (!previewClone) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "preview requested but the working dir could not be cloned; refusing to run in the real cwd",
                  preview_unavailable: true,
                }),
              },
            ],
            isError: true,
          };
        }
        workdir = previewClone.path;
      }

      // From here, a finally drops the preview clone on EVERY exit (return or throw),
      // so a disposable clone can never leak — even if a later step throws.
      try {
      // Sandbox enforcement. Wrap the command for kernel-level confinement.
      // Honesty contract: if confinement is unavailable, refuse rather than run free.
      let toRun = command;
      let sandboxed = false;
      let secretsProtected = 0;
      let secretsUnprotected: string[] = [];
      // Did the sandbox request file-level secret protection? If so we auto-scrub the
      // env too (OGL-98 coupling) — masking ~/.ssh while leaving $AWS_SECRET_ACCESS_KEY
      // readable would be an inconsistent half-measure.
      let sandboxProtectsSecrets = false;
      if (sandbox) {
        if (!sandboxAvailable()) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "sandbox requested but unavailable (needs macOS sandbox-exec, or Linux bubblewrap / Landlock-landrun); refusing to run unconfined",
                  sandbox_unavailable: true,
                }),
              },
            ],
            isError: true,
          };
        }
        try {
          const raw =
            sandbox === true
              ? {}
              : (sandbox as { network?: boolean; writable?: string[]; protect_secrets?: boolean; deny_read?: string[] });
          sandboxProtectsSecrets = !!raw.protect_secrets || !!(raw.deny_read && raw.deny_read.length);
          const { dirs: denyRead, droppedFiles } = partitionSecrets([
            ...(raw.protect_secrets ? defaultSecretPaths() : []),
            ...(raw.deny_read ?? []),
          ]);
          const sbOpts: SandboxOpts = { network: raw.network, writable: raw.writable };
          if (denyRead.length) sbOpts.denyRead = denyRead;
          toRun = wrapCommand(command, workdir, sbOpts);
          sandboxed = true;
          secretsProtected = denyRead.length;
          secretsUnprotected = droppedFiles;
        } catch (e) {
          // A backend that can't enforce a REQUESTED knob (e.g. Landlock + network-deny
          // / read-confine) throws so we refuse. Surface a machine-readable flag, not
          // just a string, mirroring the sandbox_unavailable contract.
          const msg = String(e instanceof Error ? e.message : e);
          const unsupported = /landlock backend cannot enforce/i.test(msg);
          return {
            content: [{ type: "text", text: JSON.stringify({ error: msg, ...(unsupported ? { sandbox_unsupported_feature: true } : {}) }) }],
            isError: true,
          };
        }
      }

      // OGL-98 — scrub credential-shaped vars from the child env. Enabled explicitly
      // via scrub_env, or implicitly when the sandbox already protects secret dirs (so
      // env and filesystem stay consistent). When off, the child inherits process.env.
      const scrubEnvEffective = scrub_env || sandboxProtectsSecrets;
      let childEnv: NodeJS.ProcessEnv = process.env;
      let secretsEnvScrubbed = 0;
      if (scrubEnvEffective) {
        const { env: scrubbedEnv, scrubbed } = scrubSecretEnv(process.env);
        childEnv = scrubbedEnv;
        secretsEnvScrubbed = scrubbed.length;
      }

      // Best-effort structured syscall trace. Wrap OUTERMOST so the tracer
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
      // Preview derives effects from a clone-vs-origin tree diff (below), so it never
      // takes git snapshots of the (cloned) workdir.
      const useTrace = traceDir !== undefined;
      // Only the plain git-diff effect path is racy under concurrency: it snapshots
      // `git status` before and after, so a parallel run writing into the SAME repo
      // mid-window gets cross-attributed. Preview is clone-isolated and trace is
      // per-process, so neither needs serialization.
      const useGitDiff = !previewClone && !useTrace && trackEffects;

      // The whole before→run→after sequence, returning its results so they stay
      // typed for the result-building below. On the git-diff path this runs under a
      // per-repo lock (see the caller) so same-repo effect-tracked runs serialize and
      // don't steal each other's writes; off that path it runs directly, fully
      // concurrent. Escape hatches if serialization is unwanted: trace:true is
      // per-process (immune), and VEIL_EFFECTS=0 disables the diff entirely.
      interface EffectWindow {
        res: Awaited<ReturnType<typeof runWithRetry>>;
        filesChanged: string[] | null;
        traceText: string | undefined;
        traceSummary: TraceSummary | undefined;
      }
      const runEffectWindow = async (): Promise<EffectWindow> => {
        const before = useGitDiff ? gitStatus(workdir) : null;
        let res = await runWithRetry(toRun, workdir, timeout_ms ?? config.defaultTimeoutMs, retrySpec, childEnv);

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
            res = await runWithRetry(preTraceCmd, workdir, timeout_ms ?? config.defaultTimeoutMs, retrySpec, childEnv);
            traceUnavailable = true;
          }
          rmSync(traceDir, { recursive: true, force: true });
        }

        let filesChanged: string[] | null;
        if (previewClone) {
          // The command ran in the clone — report how the clone diverged from origin
          // (cwd-relative writes only). The clone is dropped after asserts, since
          // expect.file_exists/file_absent must still resolve against it.
          filesChanged = cloneDiff(origin, previewClone.path);
        } else if (useTrace) {
          // Trace ran → derive effects from what it actually wrote AND removed/renamed
          // (cwd-scoped). Residual honesty scope: a write through an ALREADY-OPEN fd
          // (inherited/dup'd across the trace boundary) and exotic mutating syscalls
          // are not captured, so files_changed is complete for create/write/delete/
          // rename but still best-effort overall. If the trace failed to capture, there
          // are no git snapshots to fall back to → null.
          filesChanged = traceSummary ? effectsFromTrace(traceSummary.wrote, traceSummary.deleted, workdir) : null;
        } else {
          const after = trackEffects ? gitStatus(workdir) : null;
          filesChanged = diffStatus(before, after);
        }
        return { res, filesChanged, traceText, traceSummary };
      };

      // Serialize the snapshot→run→snapshot window per repository on the git-diff path.
      // Key on the git top-level dir (the repo root) so runs in different repos never
      // block each other; fall back to the canonical workdir if it can't be resolved.
      const { res, filesChanged, traceText, traceSummary } = useGitDiff
        ? await withRepoLock(gitToplevel(workdir) ?? canonicalPath(workdir), runEffectWindow)
        : await runEffectWindow();

      const id = nextId();
      put(
        {
        id,
        command,
        cwd: origin,
        at: Date.now(),
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
        },
        // OGL-99 — a sensitive run is cached for sh_detail but never written to disk.
        no_store ? { persist: false } : undefined,
      );

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
      if (secretsProtected) result.secrets_protected = secretsProtected;
      // Honesty: a requested secret path that exists as a FILE can't be masked by the
      // dir-only backend — disclose it so secrets_protected is never read as "all safe".
      if (secretsUnprotected.length) result.secrets_unprotected = secretsUnprotected;
      // OGL-98 — disclose how many credential-shaped env vars were withheld from the
      // child (a count only; values are never echoed).
      if (secretsEnvScrubbed) result.secrets_env_scrubbed = secretsEnvScrubbed;
      // OGL-99 — flag a memory-only run so the agent knows sh_detail works this session
      // but nothing was persisted to disk.
      if (no_store) result.stored = "memory-only";
      if (previewClone) {
        result.preview = true;
        result.preview_method = previewClone.method;
        // Hard honesty banner: the diff above is cwd-relative ONLY; this is not a sandbox.
        result.preview_warning =
          "ran in a disposable CoW clone of cwd; changes are cwd-RELATIVE only. " +
          "Absolute-path, parent-dir, and network effects are NOT captured and may have happened for REAL. " +
          ".git and node_modules are excluded from the diff (so a previewed install/commit shows no files_changed for them). " +
          "Nothing was promoted to the real cwd. This is not a sandbox — add sandbox:true for containment.";
      }
      if (traceSummary) result.trace_summary = traceSummary;
      if (traceUnavailable) result.trace_unavailable = true;

      // Post-conditions. Verify here so no second command is needed.
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
      } else if (cls.category === "destructive" && !sandboxed && !previewClone && !destructiveNudged) {
        destructiveNudged = true; // once per process — don't nag on every rm
        result.advice = "destructive command ran unconfined — consider sandbox:true or sh_checkpoint to limit blast radius";
      } else if (looksInteractive(command)) {
        result.advice = "looks interactive/TTY-bound — sh_run buffers output and has no TTY; use raw Bash for interactive sessions";
      }

        // Compact JSON — the consumer is an LLM, not a human reader; bytes are tokens.
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } finally {
        // Preview clone has served its purpose (effects + asserts read against it).
        if (previewClone) dropPreview(previewClone.path);
      }
    },
  );
}
