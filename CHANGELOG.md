# Changelog

All notable changes to veil-mcp. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this is pre-1.0 and experimental.

## [0.7.0] — 2026-06-25

A hardening + capability pass from a full-codebase critical review (16 issues):
correctness bugs, security/honesty gaps, a major capability, and public-repo polish.
Test coverage grew from 175 to 371 smoke assertions.

### Added
- **Background / long-running processes.** `sh_run { background: true }` starts a
  command that doesn't exit (dev server, `--watch` build) and returns immediately with
  `id` + `pid` + `status: "running"`. New **`sh_logs`** polls its output incrementally
  by per-stream byte cursor (`stdout_cursor`/`stderr_cursor`) plus status/exit/signal;
  new **`sh_kill`** signals the process group (SIGTERM with a 2s→SIGKILL escalation,
  idempotent after exit). Live children are reaped on server shutdown so a dev server is
  never orphaned; `VEIL_MAX_BG_PROCS` (default 16) caps concurrency. Background refuses
  options that need completion (`expect`/`preview`/`trace`/`retries`/`full`/`timeout_ms`).
- **Env-secret scrub.** `sh_run { scrub_env: true }` strips secret-shaped environment
  variables (`*_TOKEN`/`*_KEY`/`AWS_*`/provider prefixes/…) before spawn, so the server's
  own credentials don't flow into the command. Auto-on with `sandbox.protect_secrets`;
  reports `secrets_env_scrubbed` (a count, never values). Best-effort denylist.
- **`no_store`.** Keep a sensitive run **memory-only** — addressable via `sh_detail` for
  the session, never written to disk.
- **CLI.** `veil-mcp --version` and `--help`.
- **`VEIL_MAX_STORE_BYTES`** — a total-byte budget for the record store (default 256MB),
  on top of the existing count cap.

### Changed
- **Trace effects are complete.** The syscall trace now records deletions, renames, and
  `mkdir` (not only `open`), so `files_changed` under `trace: true` covers
  create/write/delete/rename.
- **Effect-diff attribution under concurrency.** Same-repo runs that derive
  `files_changed` from `git status` serialize their before→run→after window per
  repository, so parallel runs never steal each other's changes. Opt out with
  `trace: true` (per-process) or `VEIL_EFFECTS=0`.
- **Checkpoints are namespaced per project**, so the same label taken in two different
  directories no longer clobbers one another.
- Preview's diff excludes `node_modules` (faster, with the tradeoff bannered).
- The classifier no longer over-flags a destructive token inside a quoted literal of a
  non-eval command (`echo "rm -rf /"`), while still flagging anything actually executed
  (`bash -c …`, `… | sh`, `perl -e …`, command substitution). Guarded by a
  never-under-flag corpus.
- Helper binaries (`rsync`/`diff`/`git`/`strace`/`bwrap`/`landrun`/`cp`) resolved to
  absolute paths (no PATH hijack). Internal feature-letter codes replaced with
  descriptive names in comments and docs. `shQuote` shared in one module.

### Fixed
- The timeout SIGTERM→SIGKILL escalation timer is now cancelled when the child exits
  early, so a stray SIGKILL can't land on a recycled process group.
- `gitStatus` uses a large buffer (`execFileSync`), so a big dirty/untracked set no
  longer overflows and silently reports "not a git repo".

### Security
- Server-environment credentials are no longer handed unconditionally to every child
  (`scrub_env`); sensitive runs can stay off-disk (`no_store`); secret-dir read-confine
  is documented as a scoped guarantee.

## [0.6.0] — 2026-06-23

Four scoped capabilities, each shipping only what its substrate can honestly back
(no headline that the kernel or the stored data can't keep), plus a guard-hook
refresh and an honesty/correctness audit pass.

### Added
- **Secret read-confine.** `sandbox` gains `{ protect_secrets: true }` (built-in
  credential-dir denylist: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud|gh`,
  `~/.kube`, `~/.docker`) and `{ deny_read: [...] }` (extra dirs). macOS appends
  `(deny file-read* (subpath …))` to the SBPL profile (rule order: later wins, so it
  overrides `allow default`); Linux masks each dir with an empty `--tmpfs`. Reports
  `secrets_protected: <n>`. Scoped by design — it blocks the **listed** paths, not a
  proof against all exfiltration.
- **Dry-run preview.** `sh_run { preview: true }` runs the command **inside a
  disposable CoW clone of cwd**, returns the cwd-relative `files_changed`, and never
  touches the real cwd (nothing is promoted). Refuses if the clone can't be made.
  Honest scope, bannered in `preview_warning`: absolute-path / parent-dir / network
  effects are **not** captured and may happen for real — this is **not** a sandbox.
- **`sh_history`.** Descriptive aggregates over past runs of a command — observed
  exit / retry-recovery / duration `p50`/`p90` / file-churn with explicit sample size
  `n` and recency window. Restates the local (capped, TTL-pruned) store; makes **no**
  prediction and **no** causal claim. Read-only. (`RunRecord` gains an `at` timestamp.)
- **Landlock Linux sandbox backend (K++).** A namespace-free fallback (via `landrun`,
  kernel 5.13+) that write-confines in containers / CI / Ubuntu 24.04+ where
  bubblewrap's unprivileged user namespaces are restricted. `sandboxAvailable()` now
  reports true on Linux with **bwrap OR Landlock**; `wrapCommand` prefers bwrap and
  falls back to landrun. Scoped, honest: write-confine only — it **refuses** (so the
  caller refuses) network-deny / secret-read-confine rather than fake them, and its
  self-test runs a real confined no-op (no `--best-effort`) so an unsupported kernel
  reports unavailable instead of silently running free.
- **Guard hook covers modern verbose tools.** `hooks/veil-guard.sh` now routes
  `bun`/`deno`/`uv` (install/add/run/test/build/sync) and image builds
  (`docker build`/`buildx`/`compose build`/`docker-compose build`) to `sh_run`, while
  read-only (`docker ps`/`logs`) and long-running (`bun run dev`, `docker compose up`,
  `* --watch`) forms still pass through to raw Bash. Danger branch, fail-open, and
  `VEIL_BYPASS=1` are unchanged.

### Fixed (audit pass)
- **`expect` content checks no longer lie on binary/truncated output.**
  `stdout_contains`/`stdout_matches` decode a base64 (NUL-byte) stream before testing,
  and a non-match on a byte-cap-truncated stream is annotated *inconclusive* (the
  needle may be in the dropped head) instead of a confident `pass:false`.
- **`effectsFromTrace` canonicalizes cwd** — a symlinked root (`/tmp`→`/private/tmp`,
  symlinked `$HOME`) no longer silently drops real in-cwd writes from `files_changed`.
- **Read-confine discloses what it can't protect.** A requested secret that exists as a
  FILE (the dir-only backend can't mask it) is surfaced in `secrets_unprotected` rather
  than silently dropped while `secrets_protected` counts only the dirs.
- **Server version is read from package.json** (was hardcoded `0.4.0`, drifting a full
  minor behind), asserted equal in the smoke suite.
- **Landlock knob-refusal is machine-readable** (`sandbox_unsupported_feature: true`).
- Eviction has a memory backstop (records that never reached a flaky disk can't grow
  unbounded); `nextId` won't hand back an id whose record file already exists; numeric
  env tunables are floored at 0; a committed-then-clean file is labelled "no longer
  dirty (committed or reverted)" instead of asserting "(reverted)"; the preview banner
  notes `.git` changes are excluded from its diff. Removed dead `sandboxSelfTest`.

## [0.5.0] — 2026-06-22

Skeptic-review hardening pass: fix a critical checkpoint-label vulnerability,
close several under-flag/over-claim gaps, and replace qualitative value claims
with reproducible numbers.

### Security
- **Checkpoint label `..` no longer wipes the temp dir.** `safeLabel` admitted the
  path-segment specials `.`/`..`, so a `..` label made `checkpoint()` resolve to the
  temp root and `rmSync` it recursively. Reject them explicitly and route every
  store/meta join through a `containedPath()` containment check.
- **`git clean --force` is classified destructive.** The force regex matched bundled
  short clusters but not the long `--force`, so a force-clean ran as read-only — no
  effect-tracking, no destructive nudge. A glob/redirect/`$()` no longer downgrades a
  destructive verb (`rm *`, `shred f > /dev/null`, `git reset --hard $(…)`) to `complex`.
- **Record store is owner-only.** The per-project store dir is now `0700` and record /
  lock / probe files `0600`, so captured stdout/stderr (possibly secrets) is not
  group/other-readable on a shared host.
- **Guard hook hardened.** `VEIL_BYPASS=1` is honored only as a leading env-assignment
  (a trailing `# VEIL_BYPASS=1` comment no longer bypasses), and the danger set now
  covers `find -delete`, `git clean -f/--force`, `chmod -R`, `shred`, `truncate`, and
  `rm --recursive/--force` — with `shred`/`truncate` anchored to command position so a
  benign argument/filename isn't mis-blocked.

### Fixed
- **`veil init` never deletes user content** between mismatched markers: an in-place
  replace happens only for exactly one well-formed block; ambiguous marker topologies
  append instead of swallowing the text between an orphan start and a later block.
- **Condensing surfaces more signal.** The lexicon now covers crash idioms with no
  error/fail keyword (`Segmentation fault`, `SIGSEGV`, `CONFLICT`, `! [rejected]`,
  `undefined reference`, `timed out`, `N high severity vulnerabilities`, …), and the
  elision marker reports the *true* signal total with a `+N more` overflow note instead
  of silently capping at five.
- **Snapshot method honesty.** `method: "clone"` is reported only within one volume;
  a cross-volume / non-APFS `cp -cR` (which silently full-copies) is now reported as
  `method: "rsync"`.

### Added
- **Value metrics (`npm run metrics`).** Agent-turns-saved (55% fewer round-trips),
  sandbox-escapes-blocked (5/5), signal-recall (100% on a labeled corpus), and
  checkpoint cost (CoW clone vs rsync). Deterministic dimensions are asserted in the
  smoke suite so the published figures can't drift.
- **Falsifiable backtest floor.** A per-short-command envelope-overhead floor catches
  fixed JSON bloat the byte-weighted net% structurally could not.

### Changed
- Docs corrected to match what ships: the sandbox is *probed lazily on first use* (not
  "self-tests at startup"), the guard hook is a *routing guard, not a security
  boundary*, the backtest measures *byte* savings (not a tokenizer), `sh_plan` over-
  flags *for recognized patterns* (undecidable constructs stay `complex`/`unknown`),
  and the suite is **228** assertions (some platform-gated), not 187.

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
