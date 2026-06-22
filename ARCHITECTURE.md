# Architecture

veil-mcp is a thin **orchestration/presentation layer** over command execution,
spoken over MCP so an LLM agent consumes it natively. It does not replace the shell —
it sits between the agent and the shell and turns *effects into data*.

```
agent (Claude Code)
      │  MCP (stdio)
      ▼
  server.ts ── wires tools
      │
   ┌──┴───────────┬───────────┬────────────────────┐
   ▼              ▼           ▼                    ▼
 sh_run       sh_detail    sh_plan        sh_checkpoint/restore/…
   │              │           │                    │ uses
   │ composes     │ uses      │ uses               ▼
   ▼              ▼           ▼                  snapshot (APFS clone / rsync)
 policy(sandbox) store       classify
   │                                  ▲
   ▼                                  │
 trace ─ exec ─ effects ─ render ─ signals
   │       │       │         │ uses
   └ assert ◄──── config / types ┘
```

`sh_run` composes the pipeline: optionally wrap the command for `policy` (sandbox)
and `trace`, run via `exec` (timeout + bounded buffer + retry), gather `effects`
(git porcelain — or derived from the `trace`), `render` (condense via `signals`),
evaluate `assert`, and store the record for `sh_detail`.

## Module → responsibility

| Module               | Responsibility                                              |
|----------------------|-------------------------------------------------------------|
| `config.ts`          | Env-overridable tunables (limits, timeout).                 |
| `types.ts`           | Shared `ExecResult` / `RunRecord`.                          |
| `exec.ts`            | Spawn; enforce timeout; bound buffering; declarative retry. |
| `effects.ts`         | git porcelain before/after diff; or effects derived from a trace (skips git). |
| `render.ts`          | Token-aware condensing (head+tail+pointer); truncation-aware; CR-normalized line counting. |
| `signals.ts`         | Content-aware extraction of FAIL/error/warn lines from the hidden middle. |
| `store.ts`           | Addressable per-session record store with eviction.         |
| `assert.ts`          | Post-condition evaluator (`expect`).                        |
| `classify.ts`        | Static command classification (blast radius + mutations).   |
| `policy.ts`          | Real sandbox enforcement (macOS sandbox-exec SBPL; Linux bubblewrap). |
| `trace.ts`           | Structured syscall/FS trace (Linux strace) + read/write summarizer. |
| `snapshot.ts`        | Checkpoint/restore — APFS CoW clone (`cp -c`) or rsync mirror; origin-dir guard. |
| `tools/sh_run.ts`    | Compose exec+effects+render+store+assert+retry.             |
| `tools/sh_detail.ts` | Pull stored slices by id.                                   |
| `tools/sh_plan.ts`   | Dry-run via `classify`, no execution.                       |
| `tools/sh_snapshot.ts` | `sh_checkpoint` / `sh_restore` / `sh_checkpoints`.        |
| `server.ts`/`index.ts` | Build + boot over stdio.                                  |

## Feature → module map

| Feature                         | Status | Lives in                       |
|---------------------------------|--------|--------------------------------|
| **I** token-aware output        | done   | `render.ts`, `tools/sh_run.ts` |
| output honesty (signal/trunc/binary) | done | `signals.ts`, `render.ts`, `exec.ts`, `tools/sh_run.ts` |
| **J** addressable output        | done   | `store.ts`, `tools/sh_detail.ts` |
| **H** effect diff               | done   | `effects.ts`                   |
| timeout + output cap (safety)   | done   | `exec.ts`, `config.ts`         |
| **G** inline assertions         | done   | `assert.ts` + `sh_run` `expect` |
| **M** declarative retry/timeout | done   | `exec.ts` `runWithRetry` + `sh_run` |
| **B** dry-run (known commands)  | done   | `classify.ts` + `tools/sh_plan.ts` |
| **K-lite** blast-radius class.  | done   | `classify.ts` + `tools/sh_plan.ts` |
| **C** checkpoint / rollback     | done   | `snapshot.ts` (APFS clone / rsync fallback) + `tools/sh_snapshot.ts` |
| **K** sandbox enforcement       | done (macOS) | `policy.ts` (sandbox-exec SBPL) + `sh_run` `sandbox` |
| **C+** atomic CoW checkpoints   | done (macOS) | `snapshot.ts` APFS `clonefile` (`cp -c`) + rsync fallback |
| **K+** Linux sandbox backend    | experimental | `policy.ts` `buildBwrapArgs` (bubblewrap); arg-builder unit-tested, live write-confine covered by a Linux CI test (`test/smoke.ts`, Ubuntu leg) |
| **A** structured trace          | experimental | `trace.ts` (strace summarizer, best-effort) + `sh_run` `trace`; capture validated on Linux CI |

## Boundary: what this layer can and cannot guarantee

- **Can** (presentation/orchestration): quiet output, addressable detail, effect
  diff, trace, asserts, retry — all here, natively consumable by the agent.
- **Cannot** (needs FS/kernel): atomic rollback, universal dry-run, real sandbox.
  Those require copy-on-write snapshots and seccomp/landlock — separate lower
  layers this server would *drive*, not implement. A zsh fork couldn't do them
  either; they don't live in the shell.

## Invariants

- **stdout is the MCP channel.** All logging goes to stderr.
- **Detail is never lost, only deferred.** Condensed views always carry an
  `sh_detail` pointer to the full bytes.
- **Quiet on success, generous on failure.** Token spend follows where it matters.
- **Quiet must never mean dishonest.** Condensing may hide bulk but not signal: a
  mid-stream failure is surfaced, a truncated stream says so (and never labels its
  tail as the head), line counts are the true emitted count, and binary bytes are
  preserved (base64) rather than mangled. Economy may not cost decision quality.
