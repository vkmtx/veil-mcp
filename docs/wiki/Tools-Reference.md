# Tools Reference

| Tool | Purpose |
|------|---------|
| `sh_run` | Run a command → quiet structured result; full output stored, not re-emitted |
| `sh_detail` | Pull stored `stdout`/`stderr`/`meta`/`trace` for a past run by id (no re-run; survives restarts) |
| `sh_plan` | Static safety pre-check of a command's blast radius (no execution) |
| `sh_checkpoint` | Snapshot a directory under a label (CoW clone / rsync) |
| `sh_restore` | Restore a directory from a checkpoint |
| `sh_checkpoints` | List checkpoint labels |

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
| `sandbox` | Real OS sandbox: `true` confines writes to cwd + temp; `{ network: false }` denies network; `{ writable: [...] }` adds roots. **Refuses to run** if unavailable — see [[Sandbox and Trace]] |
| `trace` | Structured FS/syscall trace (Linux `strace`); best-effort. See [[Sandbox and Trace]] |

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
`stdout_binary`/`stderr_binary`, `sandboxed`, `trace_summary`/`trace_unavailable`,
`assert_ok`/`assertions_failed`, `advice`, `hint`, and condensed `stdout`/`stderr`.

## `sh_detail`

```jsonc
sh_detail { "id": "cmd9", "selector": "stdout" }                 // full stored stream
sh_detail { "id": "cmd9", "selector": "stdout", "match": "ERROR" } // only matching lines + numbers
sh_detail { "id": "cmd9", "selector": "meta" }                   // metadata only
sh_detail { "id": "cmd9", "selector": "trace" }                  // full syscall trace
```

Records are **disk-backed**, so this works even after the server restarts. `match`
greps the stored stream so you can pull a value condensing hid without dumping it all.

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
sh_checkpoints {}                             // list labels
```
