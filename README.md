# veil-mcp

[![CI](https://github.com/vkmtx/veil-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vkmtx/veil-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/veil-mcp.svg)](https://www.npmjs.com/package/veil-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)

**An agent-native shell, as an MCP server.** The first shell layer designed assuming
the operator is an **LLM agent** (Claude Code), not a human at a terminal.

A terminal dumps everything into the scrollback and the agent swallows it all —
regex-ing fragile text, round-tripping for state, with no undo. **veil** turns that
into structured data: effects come back typed, detail is addressable and pulled only
when needed, and risky commands get a real safety net.

> **quiet-by-default · addressable · lazy-detail · structured-replaces-text**

- **Effects are data.** Files changed via git porcelain (or a syscall trace), not a `git status` round-trip.
- **Verify in one call.** `expect: { exit: 0, file_exists: "dist/index.js" }` — no follow-up `ls`/`grep`.
- **Safety net.** `sh_checkpoint`/`sh_restore` (CoW snapshot) and an opt-in kernel `sandbox` for risky commands.
- **Detail is stored, not re-emitted.** Pull `sh_detail id=cmd3 selector=stdout` only if needed — and it **survives a server restart** (disk-backed).
- **Token economy is the consequence, not the bet.** Quiet output is a side effect of returning structure; the structure and safety stay valuable even as context windows grow. Condensing hides bulk while surfacing failure signal — a best-effort heuristic, measured at **100% recall** on a labeled corpus of buried failures (see [Output honesty](#output-honesty) and [Metrics](#metrics)).

## Why veil

Much of what an agent gets from veil — quieter output, fewer manual checks — you can
approximate with Bash + truncation + careful prompting. The reason to adopt is the
**three things a shell genuinely cannot do**, each with a number you can reproduce
(`npm run metrics`):

1. **Verify in one call, not three.** `expect` folds a `run → check → grep` loop into
   a single structured call (`exit`, `stdout_matches`, `file_exists`, `changed`, …),
   and effects come back **typed** — so "what changed?" needs no `git status`
   round-trip. → **55% fewer MCP round-trips** across five common tasks (11 → 5).
2. **A real safety net — checkpoint & roll back.** `sh_checkpoint`/`sh_restore` wrap a
   risky refactor in an undo. On a same-volume APFS tree it's a copy-on-write clone:
   **~1.5× faster than an rsync mirror and near space-free** (~0 MB vs 60 MB on a
   60 MB tree), cheap enough to make a checkpoint-before-every-risky-step a habit.
3. **Kernel-enforced confinement, not a prompt.** `sandbox: true` confines writes to
   cwd + temp (and optionally denies network) via the OS sandbox — and **refuses to
   run** rather than execute unconfined where unavailable. An adversarial corpus of
   escape attempts is **blocked 5/5** while a legitimate in-cwd write still lands.

Everything else — quiet output, addressable detail, retry, classification — is
genuine convenience layered on top, not the moat. Honest scope: the sandbox is solid
on macOS and experimental on Linux (see [Security](#security)); the numbers above are
from [Metrics](#metrics), reproducible locally with no account.

## Why an MCP server, not a forked shell

Most of the value — token-aware output, addressable detail, effect diff, asserts,
retry, dry-run — is a **presentation/orchestration layer**. An MCP server delivers
it natively to how the LLM already consumes tools, in weeks not months, with no
200k-line C fork to maintain. The things a shell fork *also* can't do alone (atomic
rollback, a real capability sandbox, syscall trace) live in the **FS + kernel**;
veil *drives* those layers (APFS clonefile, `sandbox-exec`/bubblewrap, `strace`)
rather than reimplementing a shell.

## Install

Fastest path — no clone, no build (runs via `npx`):

```bash
claude mcp add veil -- npx -y veil-mcp
npx -y veil-mcp init     # drop the agent nudge into this project's CLAUDE.md
```

For other MCP-speaking agents (Cursor, Windsurf, Zed, …), add to the MCP server config:

```jsonc
{ "mcpServers": { "veil": { "command": "npx", "args": ["-y", "veil-mcp"] } } }
```

Prefer to run straight from source, without npm? `npx -y github:vkmtx/veil-mcp` works too.

`veil init` is the zero-friction setup step: it writes (idempotently) the block that
tells the agent to prefer `sh_run`. See [Adoption](#adoption) for why that step exists.

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
| `sh_detail` | Pull full stored `stdout`/`stderr`/`meta`/`trace` for a previous run by id — no re-run. Records are **disk-backed**, so this works even after the server restarts. `match=<regex>` greps the stored stream (matching lines + numbers) to find a value condensing hid, without dumping it all. |
| `sh_plan` | **Static safety pre-check** (not an execution dry-run): predicts a command's blast-radius category (read-only / mutating / destructive / network / complex / unknown), reversibility, and file effects **without executing**. A top-level pipeline/list (`a && b`, `c \| d`) is decomposed and classified per-segment, worst case wins; substitution/redirect/glob are undecidable and stay `complex` (though a destructive verb behind one is still surfaced). Errors bias toward over-flagging for the patterns it recognizes; genuinely-undecidable constructs stay `complex`/`unknown` — an honest limit, not a universal guarantee. |
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

- A mid-stream failure between head and tail is **surfaced** inline (content-aware
  `signals.ts`) — the lexicon covers crash idioms with no error/fail keyword too
  (`Segmentation fault`, `SIGSEGV`, `CONFLICT`, `! [rejected]`, `timed out`, …). If
  more distinct signals exist than fit inline, the marker reports the **true total**
  with a `+N more` overflow note (never a silent cap). This is a best-effort heuristic,
  not a proof — but it is **measured**: 100% recall on a labeled corpus ([Metrics](#metrics)).
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

## Adoption

veil is **opt-in and complementary** to Bash, not a drop-in replacement. Its value
only lands when the agent actually reaches for `sh_run` on effect-bearing or verbose
commands — and an agent left to its own judgment will often default to raw Bash. Two
levers close that gap, in increasing strength:

1. **The nudge** — a short block in the project's `CLAUDE.md` telling the agent to
   prefer `sh_run`. `veil init` writes it for you (idempotent). Soft, zero-friction.
2. **The guard hook** — [`hooks/veil-guard.sh`](#optional-enforce-with-a-hook) hard-blocks
   *verbose*/*dangerous* Bash and steers it to `sh_run`, while explicitly letting
   interactive/long-running/background commands through. Stronger, opt-in per machine.

Honest limit: there is no native integration, so adoption depends on one of the above
being configured. `veil init` reduces that to a single command; it does not remove the
step. If you only want the tools available without changing agent behavior, skip both —
`sh_run` is still callable directly.

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
| `VEIL_STATE_DIR` | auto | on-disk record store base (auto: `$XDG_STATE_HOME/veil` → `~/.local/state/veil` → `$TMPDIR/veil`). `none`/`off` = memory-only |
| `VEIL_RECORD_TTL_MS` | 86400000 | persisted records older than this are pruned on boot (0 = keep) |
| `VEIL_EFFECTS` | true | compute the git effect-diff (set `0` to skip in huge repos) |

## Optional: enforce with a hook

The nudge is a soft preference. [`hooks/veil-guard.sh`](hooks/veil-guard.sh)
is a `PreToolUse` guard that hard-blocks only **verbose** (installs / builds / test
runners) or **dangerous** (`rm -rf`, `dd`, `mkfs`, raw-device writes) Bash commands,
steering them to `sh_run`. It is a **routing guard, not a security boundary**: it
changes *which tool* the agent reaches for, never whether a command may run (it is
fail-open and `VEIL_BYPASS`-able, and `sh_run` will execute the same command). Real
containment is the kernel [`sandbox`](#security), not this hook. Commands `sh_run` **can't** help with are explicitly
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

**Portability is honest, not universal.** The sandbox is an opt-in best-effort layer,
not a headline guarantee: macOS is solid; Linux bubblewrap is experimental and needs
unprivileged user namespaces; **containers** (Docker, Codespaces, many CI runners) and
Ubuntu 24.04+ often restrict those, so `sandbox` is probed lazily on the first
sandboxed call and reports unavailable there — by design, so it refuses rather than
pretends. The default,
non-sandboxed path works everywhere. (A namespace-free Linux backend via Landlock is
on the roadmap to cover the container case.)

## Roadmap

| | Feature | Status |
|---|---------|--------|
| **I** | token-aware output | ✅ done |
| **J** | addressable output (`sh_detail`, `match`) | ✅ done |
| **H** | effect diff (git porcelain / trace-derived) | ✅ done |
| **G** | inline assertions (`expect`) | ✅ done |
| **M** | declarative retry/timeout | ✅ done |
| **B / K-lite** | static safety pre-check + classification (`sh_plan`) — segment-aware, *not* an execution dry-run | ✅ done |
| **C** | checkpoint / rollback | ✅ done |
| **K** | real sandbox (macOS `sandbox-exec`) | ✅ done |
| **C+** | atomic CoW checkpoints (APFS `clonefile`) | ✅ done — same-volume APFS; cross-volume / non-APFS falls back to the rsync mirror and reports `method: rsync` (no false "clone") |
| **J+** | disk-backed record store (`sh_detail` survives restart, TTL-pruned) | ✅ done (v0.4) |
| — | `veil init` zero-friction project setup | ✅ done (v0.4) |
| **K+** | Linux sandbox (bubblewrap) | 🧪 experimental — write-confine validated on Linux CI (needs unprivileged user namespaces; Ubuntu 24.04+ / containers restrict them, so `sandbox` reports unavailable there unless relaxed) |
| **A** | structured trace (Linux `strace`) | 🧪 experimental — capture validated on Linux CI |
| **K++** | namespace-free Linux sandbox (Landlock) — covers containers/Codespaces where bwrap can't | 🔭 planned |
| — | streaming / PTY + background jobs (`sh_logs`/`sh_stop`) | 🔭 planned |

See [CHANGELOG.md](CHANGELOG.md) for version history and [ARCHITECTURE.md](ARCHITECTURE.md)
for the module/feature map.

## Testing — verify it yourself

Don't take the numbers on trust — reproduce them. Everything runs locally, no account:

```bash
git clone https://github.com/vkmtx/veil-mcp && cd veil-mcp && npm install
npm run typecheck    # tsc --noEmit
npm test             # end-to-end smoke (228 assertions; some are platform-gated, so a single run executes a subset)
npm run backtest     # byte-savings regression (a weighted bulk-condense ratio + a per-command envelope-overhead floor)
npm run bench        # detailed 5-dimension benchmark (economy, latency, per-feature, condense, session)
npm run metrics      # value metrics: agent-turns-saved, sandbox-escapes-blocked, signal-recall, checkpoint cost
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the suite on macOS
**and** Linux (with bubblewrap + strace installed), so the Linux-only sandbox (K+)
and trace (A) paths are exercised where this dev machine (macOS) can't. The badge at
the top reflects the latest run; the claims here are whatever that pipeline asserts.

## Metrics

`npm run metrics` quantifies the value the rest of this README describes — the moat
that raw Bash + truncation can't replicate. Numbers below are illustrative
(machine-dependent for the timing rows); reproduce them yourself.

| Metric | Result | What it measures |
|--------|--------|------------------|
| **Agent turns saved** | **55% fewer** round-trips (11 → 5) | MCP calls collapsed by `expect` + effects + retry across 5 common tasks — counts *calls*, not bytes, so it holds as context windows grow |
| **Sandbox escapes blocked** | **5 / 5** (control write lands) | adversarial outside-cwd / spawned-child / symlink / network writes denied by the kernel; a legitimate in-cwd write still succeeds (selective, not deny-all) |
| **Signal recall** | **100%** on a 10-fixture corpus | buried failures surfaced from the elided middle, incl. non-keyword crash idioms (`SIGSEGV`, `CONFLICT`, `! [rejected]`, `timed out`) |
| **Checkpoint cost** | clone **~1.5× faster, ~0 MB** vs rsync 60 MB | CoW clone latency + disk vs the rsync mirror on a 60 MB tree (macOS / same-volume APFS) |

The deterministic rows (turns, recall) are asserted in the smoke suite from the same
fixtures, so the published figures can't silently drift. On platforms without the
real sandbox/clone, those rows self-report unavailable rather than printing a number.

## Community

Contributions, questions, and ideas are welcome — this is an early project and a good
time to shape it.

- 💬 **[Discussions](https://github.com/vkmtx/veil-mcp/discussions)** — questions, ideas, show-and-tell.
- 🐛 **[Issues](https://github.com/vkmtx/veil-mcp/issues)** — bugs and feature requests (templates provided).
- 🌱 **[Good first issues](https://github.com/vkmtx/veil-mcp/labels/good%20first%20issue)** — scoped entry points for a first PR.
- 📖 **[CONTRIBUTING.md](CONTRIBUTING.md)** — dev setup and the test gate.
- 🤝 **[Code of Conduct](CODE_OF_CONDUCT.md)** — be decent.

## License

MIT — see [LICENSE](LICENSE).

## Status

v0.4 — experimental. Features I, J, H, G, M, B, K-lite, C, **K**, **C+**, plus v0.4's
**disk-backed store** and **`veil init`**, built and tested (228 smoke assertions +
backtest + value metrics, all green on macOS); **K+** and **A** structured and validated on Linux CI.
A young, single-author project — judge it by the reproducible suite above, not its age.
