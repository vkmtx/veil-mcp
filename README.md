# veil-mcp

[![CI](https://github.com/vkmtx/veil-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vkmtx/veil-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)

**An agent-native shell, as an MCP server.** The first shell layer designed assuming
the operator is an **LLM agent** (Claude Code), not a human at a terminal.

A terminal dumps everything into the scrollback and the agent swallows it all —
burning context and regex-ing fragile text. **veil** keeps the bulk behind a veil and
lifts it on demand: effects come back as data, detail is addressable and pulled only
when needed.

> **quiet-by-default · addressable · lazy-detail · structured-replaces-text**

- **Success = one line.** `{ id: "cmd3", exit: 0, ok: true, ms: 412, files_changed: ["M src/x.ts"] }`
- **Failure expands** — stderr surfaces where it matters; a hint points at the detail.
- **Detail is stored, not re-emitted.** Pull `sh_detail id=cmd3 selector=stdout` only if needed.
- **Effects are data.** Files changed via git porcelain (or a syscall trace), not a `git status` round-trip.
- **Economy never costs quality.** Condensing hides bulk, never signal (see [Output honesty](#output-honesty)).

## Why an MCP server, not a forked shell

Most of the value — token-aware output, addressable detail, effect diff, asserts,
retry, dry-run — is a **presentation/orchestration layer**. An MCP server delivers
it natively to how the LLM already consumes tools, in weeks not months, with no
200k-line C fork to maintain. The things a shell fork *also* can't do alone (atomic
rollback, a real capability sandbox, syscall trace) live in the **FS + kernel**;
veil *drives* those layers (APFS clonefile, `sandbox-exec`/bubblewrap, `strace`)
rather than reimplementing a shell.

## Install

Fastest path — no clone, no build (runs from GitHub via `npx`):

```bash
claude mcp add veil -- npx -y github:vkmtx/veil-mcp
```

Once published to npm this becomes `npx -y veil-mcp`. For other MCP-speaking agents
(Cursor, Windsurf, Zed, …), add to the MCP server config:

```jsonc
{ "mcpServers": { "veil": { "command": "npx", "args": ["-y", "github:vkmtx/veil-mcp"] } } }
```

### From source

```bash
git clone https://github.com/vkmtx/veil-mcp && cd veil-mcp
npm install                       # builds dist/ via the prepare script
claude mcp add veil -- node "$(pwd)/dist/index.js"
# dev, no build step:  npm run dev   (tsx src/index.ts)
```

Add the nudge in this repo's [`CLAUDE.md`](CLAUDE.md) (or your global
`~/.claude/CLAUDE.md`) so the agent prefers `sh_run` for effect-bearing / verbose
commands. To *enforce* it, see [the guard hook](#optional-enforce-with-a-hook).

## Tools

| Tool | Purpose |
|------|---------|
| `sh_run` | Execute a command → quiet structured result (exit, duration, files changed, token-aware stdout/stderr). Options below. |
| `sh_detail` | Pull full stored `stdout`/`stderr`/`meta`/`trace` for a previous run by id — no re-run. `match=<regex>` greps the stored stream (matching lines + numbers) to find a value condensing hid, without dumping it all. |
| `sh_plan` | Dry-run: statically predict a command's blast-radius category (read-only / mutating / destructive / network / complex / unknown), reversibility, and file effects — **without executing**. |
| `sh_checkpoint` | Snapshot a directory under a label (rollback point). APFS copy-on-write clone when possible, else rsync mirror. |
| `sh_restore` | Restore a directory from a checkpoint (undo); refuses a target dir different from where the checkpoint was taken. |
| `sh_checkpoints` | List checkpoint labels. |

### `sh_run` options

| Option | Effect |
|--------|--------|
| `command` | The shell command (required). |
| `cwd` | Working directory (defaults to the server's cwd). |
| `full` | Return uncondensed stdout/stderr inline (escape hatch from condensing). |
| `timeout_ms` | Per-command timeout (default 120s). On expiry the whole **process group** is killed (SIGTERM→SIGKILL), so a compound command's grandchildren (`sleep 5; …`) are reaped too. |
| `expect` | Post-conditions verified in the same call: `exit`, `stdout_contains`, `stdout_matches`, `stderr_empty`, `file_exists`, `file_absent`, `changed`, `max_ms`. Failures surface in `assert_ok` + `assertions_failed` — no second `ls`/`grep`/`git status` needed. |
| `retries` / `retry_on_exit` / `backoff_ms` | Declarative retry; `attempts` is reported when > 1. |
| `sandbox` | Real OS sandbox (feature **K**). `true` confines file **writes** to cwd + temp; `{ network: false }` also denies network; `{ writable: [...] }` adds roots. **Refuses to run** if unavailable — never executes unconfined. Sets `sandboxed: true`. |
| `trace` | Structured FS/syscall trace (feature **A**, Linux `strace`). Surfaces `trace_summary` (paths read/written + syscall count); full trace via `sh_detail selector=trace`. **Best-effort**: no tracer → command still runs, `trace_unavailable: true`. |

### Result fields (emitted only when relevant — the quiet contract)

`id`, `exit`, `ok`, `ms`; then `attempts`, `stdout_lines`/`stderr_lines` (TRUE
emitted counts), `files_changed`, `timed_out`, `stdout_truncated`/`stderr_truncated`,
`stdout_binary`/`stderr_binary`, `sandboxed`, `trace_summary`/`trace_unavailable`,
`assert_ok`/`assertions_failed`, `advice`, `hint`, and the condensed `stdout`/`stderr`.

### Output honesty

Condensing saves tokens but must not hide signal. Therefore:

- A mid-stream `FAIL`/`error`/`warning` between head and tail is **surfaced** inline
  (content-aware `signals.ts`), not silently dropped.
- A byte-capped stream is **labeled** (the kept tail is marked; the torn first
  fragment dropped) and never presents its tail as the head.
- `stdout_lines`/`stderr_lines` are the **true emitted** count, not just retained bytes.
- Binary output (NUL bytes) is stored **base64** and flagged, not mangled to mojibake.
- The effect-diff is skipped for statically read-only commands (and via
  `VEIL_EFFECTS=0`); a `changed` assertion still forces it.
- `advice` (never blocks) nudges on the highest-signal issue: a sandbox denial → how
  to widen it; an unconfined destructive command → `sandbox:true`/`sh_checkpoint`; an
  interactive/TTY command → use raw Bash.

### Example

```jsonc
// build AND verify the artifact exists, in one call — no follow-up ls
sh_run { "command": "npm run build", "expect": { "exit": 0, "file_exists": "dist/index.js" } }

// predict blast radius before running (git is classified per-subcommand)
sh_plan { "command": "git push --force" }   // → { category: "destructive", warning: "…" }

// confine a risky command to the cwd, deny network
sh_run { "command": "./untrusted.sh", "sandbox": { "network": false } }

// safety net around a refactor
sh_checkpoint { "label": "pre-refactor" }
sh_restore   { "label": "pre-refactor" }     // undo everything

// find a value a condensed 50k-line log hid — no re-run, no full dump
sh_detail { "id": "cmd9", "selector": "stdout", "match": "ERROR|version=" }
```

## Configuration

All tunables are env-overridable (no rebuild):

| Env var | Default | Meaning |
|---------|---------|---------|
| `VEIL_INLINE_MAX_LINES` | 45 | stdout shorter than this (lines) is returned whole |
| `VEIL_HEAD_LINES` | 20 | lines kept from the top when condensing |
| `VEIL_TAIL_LINES` | 20 | lines kept from the bottom when condensing |
| `VEIL_MAX_LINE_CHARS` | 1000 | max chars of any single inline line (longer → capped with a pointer) |
| `VEIL_STDERR_INLINE_ON_FAIL` | 60 | on failure, show up to this many stderr lines inline |
| `VEIL_TIMEOUT_MS` | 120000 | default per-command timeout (0 = none) |
| `VEIL_MAX_STREAM_BYTES` | 5000000 | max bytes stored per stream (older dropped) |
| `VEIL_MAX_RECORDS` | 500 | max addressable run records (oldest evicted) |
| `VEIL_EFFECTS` | true | compute the git effect-diff (set `0` to skip in huge repos) |

## Optional: enforce with a hook

The nudge is a soft preference. [`hooks/veil-guard.sh`](hooks/veil-guard.sh)
is a `PreToolUse` guard that hard-blocks only **verbose** (installs / builds / test
runners) or **dangerous** (`rm -rf`, `dd`, `mkfs`, raw-device writes) Bash commands,
steering them to `sh_run`. Commands `sh_run` **can't** help with are explicitly
**allowed** through to raw Bash: long-running / `dev` / `watch` / `start` servers,
backgrounded jobs (trailing `&`), process management (`kill`/`pkill`/`pgrep`), and
interactive/TTY tools (`vim`/`less`/`top`/`tail -f`) — blocking those would only
break the flow, since `sh_run` blocks until exit and has no TTY/background. It is
**fail-open** (any parse error → allow, so a bug can never block all Bash) with an
escape hatch: prefix a command with `VEIL_BYPASS=1` to force raw Bash. Enable globally in `~/.claude/settings.json`:

```jsonc
{ "hooks": { "PreToolUse": [
  { "matcher": "Bash",
    "hooks": [{ "type": "command",
      "command": "/bin/sh '/ABSOLUTE/PATH/veil-mcp/hooks/veil-guard.sh'" }] }
] } }
```

Takes effect on the next Claude Code restart. Remove the entry to disable.

## Security

`sh_run` executes **arbitrary shell commands** with the user's privileges and
exposes the server's full environment (including secrets in env vars) to them. This
is by design — it is a shell. Run it only in trusted contexts.

For a single risky command, opt into real kernel confinement with `sandbox`
(macOS `sandbox-exec`; Linux bubblewrap, experimental): writes confined to cwd +
temp, network optionally denied. Off by default; when requested where unavailable
the call **refuses** rather than running unconfined.

## Roadmap

| | Feature | Status |
|---|---------|--------|
| **I** | token-aware output | ✅ done |
| **J** | addressable output (`sh_detail`, `match`) | ✅ done |
| **H** | effect diff (git porcelain / trace-derived) | ✅ done |
| **G** | inline assertions (`expect`) | ✅ done |
| **M** | declarative retry/timeout | ✅ done |
| **B** | dry-run / blast-radius (`sh_plan`) | ✅ done |
| **K-lite** | static classification | ✅ done |
| **C** | checkpoint / rollback | ✅ done |
| **K** | real sandbox (macOS `sandbox-exec`) | ✅ done |
| **C+** | atomic CoW checkpoints (APFS `clonefile`) | ✅ done |
| **K+** | Linux sandbox (bubblewrap) | 🧪 experimental — write-confine validated on Linux CI (needs unprivileged user namespaces; Ubuntu 24.04+ restricts them by default, so `sandbox` reports unavailable there unless relaxed) |
| **A** | structured trace (Linux `strace`) | 🧪 experimental — capture validated on Linux CI |
| — | persistent FS-watcher effects (no git) | 🔭 planned |
| — | streaming / PTY (interactive, live output) | 🔭 planned |

See [CHANGELOG.md](CHANGELOG.md) for version history and [ARCHITECTURE.md](ARCHITECTURE.md)
for the module/feature map.

## Testing

```bash
npm run typecheck    # tsc --noEmit
npm test             # end-to-end smoke (150 assertions over a live stdio server)
npm run backtest     # token-savings regression (weighted net must stay > floor)
npm run bench        # detailed 5-dimension benchmark (economy, latency, per-feature, condense, session)
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the suite on macOS
**and** Linux (with bubblewrap + strace installed), so the Linux-only sandbox (K+)
and trace (A) paths are exercised where this dev machine (macOS) can't.

## License

MIT — see [LICENSE](LICENSE).

## Status

v0.3 — experimental. Features I, J, H, G, M, B, K-lite, C, **K**, **C+** built and
tested (150 smoke assertions + backtest, all green on macOS); **K+** and **A**
structured and validated on Linux CI.
