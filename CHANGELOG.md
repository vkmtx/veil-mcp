# Changelog

All notable changes to veil-mcp. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this is pre-1.0 and experimental.

## [0.4.0] — 2026-06-22

Hardening pass addressing six external critiques: weak adoption story, an
over-stated `sh_plan`, sandbox portability, in-memory-only detail, and honesty of
the value proposition.

### Added
- **J+ — disk-backed record store.** `sh_detail` now survives a server restart or
  crash: records are persisted to a per-project dir under the OS state location
  (`VEIL_STATE_DIR`, auto-resolved via XDG), cached in memory on the hot path, capped
  by `VEIL_MAX_RECORDS`, and TTL-pruned on boot (`VEIL_RECORD_TTL_MS`, default 24h).
  IDs are reserved by atomic exclusive file-create, so concurrent servers in the same
  project never collide. All disk I/O is best-effort — a read-only FS degrades to
  memory-only and never fails a run (`VEIL_STATE_DIR=none` forces it).
- **`veil init`** — zero-friction per-project setup: idempotently writes the
  "prefer `sh_run`" nudge into the project's `CLAUDE.md` and prints the MCP-registration
  + guard-hook steps. Touches only `CLAUDE.md`, never global agent settings.

### Changed
- **`sh_plan` is segment-aware and honestly labeled.** A top-level pipeline/list
  (`a && b`, `c | d`, `e; f`) is now decomposed and classified per-segment with the
  worst case winning the label — `cat f | grep x` is read-only, `cd b && rm f` is
  destructive — instead of an opaque `complex`. Substitution/redirect/glob remain
  genuinely undecidable and stay `complex`. Docs reframe `sh_plan` as a **static
  safety pre-check, not an execution dry-run**, and reposition the value proposition
  (structure + safety first; token economy as a consequence) and the sandbox
  (opt-in best-effort; unavailable in containers, by design).

## [0.3.0] — 2026-06-22

### Added
- **K — real sandbox enforcement.** `sandbox` option on `sh_run`: macOS
  `sandbox-exec` (SBPL) write-confine + optional network deny + extra writable
  roots. Refuses to run where a sandbox is unavailable (never executes unconfined).
- **C+ — atomic copy-on-write checkpoints.** `sh_checkpoint` uses APFS `clonefile`
  (`cp -c`) for instant, space-free snapshots, with a transparent rsync fallback.
- **K+ — Linux sandbox backend (experimental).** bubblewrap (`bwrap`) write-confine
  + `--unshare-net`; fail-closed. Arg-builder unit-tested; live write-confine
  asserted by a Linux CI test (Ubuntu leg).
- **A — structured trace (experimental).** `trace` option captures a syscall/FS
  trace (Linux `strace`), surfaces a read/write summary, full trace via
  `sh_detail selector=trace`. Best-effort (degrades if no tracer). When tracing,
  `files_changed` is derived from the trace and git is skipped.
- **`sh_detail match=<regex>`** — grep the stored stream for a value condensing hid.
- **`advice`** field — non-blocking nudge (sandbox denial / unconfined destructive /
  interactive command).
- **Guard hook** `hooks/veil-guard.sh` — optional `PreToolUse` enforcement
  (fail-open, `VEIL_BYPASS=1` escape).
- **CI matrix** (macOS + Linux) exercising the Linux-only sandbox/trace paths.
- **`VEIL_EFFECTS`** env toggle; comprehensive 5-dimension `npm run bench`.

### Changed (output honesty)
- Mid-stream `FAIL`/`error`/`warning` lines are surfaced inline instead of being
  hidden between head and tail (`signals.ts`).
- Truncated streams are labeled (kept tail marked, torn first fragment dropped) and
  never present the tail as the head; per-stream `stdout_truncated`/`stderr_truncated`.
- `stdout_lines`/`stderr_lines` report the TRUE emitted count, not retained bytes.
- Binary (NUL) output stored base64 and flagged instead of lossy UTF-8.
- CR-overwrite progress blobs no longer dump inline.
- Effect-diff skipped for statically read-only commands; classifier sees through
  `sudo`/`env`/`nice` wrappers and split flags.

### Fixed
- **Timeout** now kills the whole process group, so a compound command's
  grandchildren (`sleep 5; …`) are reaped — not just the shell.
- **`git` classification** is per-subcommand: `push --force`, `reset --hard`,
  `clean -f`, `branch -D`, `rebase` read as destructive; `status`/`log` read-only.
- Raw-block-device redirect guard (`> /dev/sd…`) now actually matches; fork-bomb
  pattern re-anchored.
- Deleting an untracked file reports `deleted (untracked) …`, and a `git add` on a
  dirty file no longer emits a phantom `(reverted)`.
- `sh_restore` refuses a target dir different from the checkpoint's origin
  (prevents `rsync --delete` wiping the wrong tree).

## [0.2.0]
- **M** declarative retry/timeout; **B** dry-run + **K-lite** blast-radius
  classification (`sh_plan`); **C** checkpoint/rollback (rsync mirror).

## [0.1.0]
- Initial release: **I** token-aware output, **J** addressable output (`sh_detail`),
  **H** effect diff (git porcelain), timeout + output cap, **G** inline assertions.
