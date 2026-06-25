# Tools Reference

| Tool | Purpose |
|------|---------|
| `sh_run` | Run a command → quiet structured result; full output stored, not re-emitted. `background: true` starts a long-running process |
| `sh_detail` | Pull stored `stdout`/`stderr`/`meta`/`trace` for a past run by id (no re-run; survives restarts) |
| `sh_logs` | Poll a background run's output incrementally by byte cursor, plus its status |
| `sh_kill` | Signal a background run's process group (stop a dev server / watch) |
| `sh_plan` | Static safety pre-check of a command's blast radius (no execution) |
| `sh_checkpoint` | Snapshot a directory under a label (CoW clone / rsync) |
| `sh_restore` | Restore a directory from a checkpoint |
| `sh_checkpoints` | List checkpoint labels for a project directory |

## `sh_run`

Executes a command and returns a token-aware structured result. Full output is stored
and addressable via `sh_detail` — never re-emitted into context.

| Option | Effect |
|--------|--------|
| `command` | The shell command (required) |
| `cwd` | Working directory (defaults to the server's cwd) |
| `full` | Return uncondensed stdout/stderr inline |
| `timeout_ms` | Per-command timeout (default 120s). On expiry the whole **process group** is killed |
| `expect` | Post-conditions verified in the same call (see below) |
| `retries` / `retry_on_exit` / `backoff_ms` | Declarative retry; `attempts` reported when > 1 |
| `sandbox` | Real OS sandbox: `true` confines writes to cwd + temp; `{ network: false }` denies network; `{ writable: [...] }` adds roots; `{ protect_secrets: true }` / `{ deny_read: [...] }` block reads of secret dirs. **Refuses to run** if unavailable — see [[Sandbox and Trace]] |
| `trace` | Structured FS/syscall trace (Linux `strace`); best-effort. See [[Sandbox and Trace]] |
| `scrub_env` | Strip secret-shaped env vars (`*_TOKEN`/`*_KEY`/`AWS_*`/…) before spawn; auto-on with `sandbox.protect_secrets`. Reports `secrets_env_scrubbed` (count only) |
| `no_store` | Keep the run **memory-only** — addressable via `sh_detail` this session, never written to disk. For commands that may print secrets |
| `background` | Start a long-running process and return immediately (`id` + `pid` + `status`). Poll with `sh_logs`, stop with `sh_kill`. See [Background processes](#background-processes) |

### `expect` post-conditions

`exit`, `stdout_contains`, `stdout_matches` (regex), `stderr_empty`, `file_exists`,
`file_absent`, `changed` (tracked files changed), `max_ms`. Failures surface in
`assert_ok` + `assertions_failed` — no second `ls`/`grep`/`git status` needed.

```jsonc
sh_run { "command": "npm run build", "expect": { "exit": 0, "file_exists": "dist/index.js" } }
```

### Result fields (emitted only when relevant — the quiet contract)

`id`, `exit`, `ok`, `ms`; then `attempts`, `stdout_lines`/`stderr_lines` (true emitted
counts), `files_changed`, `timed_out`, `stdout_truncated`/`stderr_truncated`,
`stdout_binary`/`stderr_binary`, `sandboxed`, `secrets_protected`/`secrets_env_scrubbed`,
`stored` (`"memory-only"` under `no_store`), `trace_summary`/`trace_unavailable`,
`assert_ok`/`assertions_failed`, `advice`, `hint`, and condensed `stdout`/`stderr`.

> Effects-as-data note: same-repo runs that compute `files_changed` from `git status`
> serialize their before→run→after window so concurrent runs never steal each other's
> changes. `trace: true` (per-process) and `VEIL_EFFECTS=0` opt out of that.

## `sh_detail`

```jsonc
sh_detail { "id": "cmd9", "selector": "stdout" }                 // full stored stream
sh_detail { "id": "cmd9", "selector": "stdout", "match": "ERROR" } // only matching lines + numbers
sh_detail { "id": "cmd9", "selector": "meta" }                   // metadata only
sh_detail { "id": "cmd9", "selector": "trace" }                  // full syscall trace
```

Records are **disk-backed**, so this works even after the server restarts. `match`
greps the stored stream so you can pull a value condensing hid without dumping it all.

## Background processes

A normal `sh_run` blocks until the command exits — wrong for a dev server or a
`--watch` build that never does. `background: true` spawns it detached and returns at
once; poll its output with `sh_logs` and stop it with `sh_kill`. The same `id` resolves
live (in-memory) while running and via `sh_detail` once it exits.

```jsonc
sh_run  { "command": "npm run dev", "background": true }   // → { id, pid, status: "running", background: true }
sh_logs { "id": "cmd7" }                                    // status + output since the start
sh_logs { "id": "cmd7", "stdout_cursor": 4096 }             // ONLY new stdout since that byte cursor
sh_kill { "id": "cmd7", "signal": "SIGTERM" }               // stop it (idempotent after exit)
```

- **`sh_logs`** — `stream` (`stdout`/`stderr`/`both`), `full`, and per-stream
  `stdout_cursor`/`stderr_cursor` (pass back the values it returns to tail only new
  output). Reports `status` (`running`/`exited`/`killed`), `exit`, `signal`,
  `running_ms`, line counts, and a `gap` flag if output was dropped at the byte cap
  between polls.
- **`sh_kill`** — `signal` (default `SIGTERM`, with a 2s → `SIGKILL` escalation);
  signals the whole **process group**. After exit it returns `already_exited`, not an error.
- Background **keeps** `cwd`, `sandbox`, `scrub_env`, `no_store`, but **refuses** options
  that need the command to finish — `expect`, `preview`, `trace`, `retries`, `full`,
  `timeout_ms` — with `background_incompatible`.
- Live processes are reaped when the server shuts down (the agent disconnects), so a
  background dev server is never orphaned. `VEIL_MAX_BG_PROCS` (default 16) caps how many
  may run at once.

## `sh_plan`

A **static safety pre-check**, not an execution dry-run. Predicts a command's category
(`read-only` / `mutating` / `destructive` / `network` / `complex` / `unknown`),
reversibility, and file effects without running it.

A top-level pipeline/list (`a && b`, `c | d`) is decomposed and classified per-segment,
worst case wins; substitution/redirect/glob are undecidable and stay `complex`. Errors
bias toward over-flagging, never under.

```jsonc
sh_plan { "command": "git push --force" }   // → { category: "destructive", warning: "…" }
```

## Checkpoints

```jsonc
sh_checkpoint { "label": "pre-refactor" }     // CoW clone (APFS) or rsync mirror
sh_restore   { "label": "pre-refactor" }      // undo; refuses a target dir != origin
sh_checkpoints {}                             // list labels for the current project
```

Checkpoints are namespaced per project (a hash of the directory), so the same label
taken in two different projects never collides. `dir` overrides the target on each tool.
