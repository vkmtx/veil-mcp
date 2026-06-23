# veil-mcp

[![CI](https://github.com/vkmtx/veil-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vkmtx/veil-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/veil-mcp.svg)](https://www.npmjs.com/package/veil-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)

**A shell built for AI agents, not humans.** veil is an MCP server that gives a coding
agent (Claude Code, Cursor, …) a shell whose results come back as **structured data** —
typed effects, one-call verification, addressable output, and a real undo — instead of
a wall of scrollback text.

A normal terminal dumps everything and the agent re-greps fragile text, round-trips for
state, and can't undo a mistake. veil turns each command into a quiet, structured
result — and adds three things a plain shell simply can't.

> **quiet-by-default · effects-as-data · lazy detail · real safety net**

## Why it's good — in three numbers

You can approximate *most* of veil with Bash + truncation + careful prompting. The
reason to actually adopt it is the **three things a shell genuinely cannot do** — each
measured, each reproducible with `npm run metrics`:

| | What you get | The number |
|--|--|--|
| ✅&nbsp;**Verify in one call** | `expect: { exit: 0, file_exists: "dist/index.js" }` folds *run → check → grep* into a single call; effects come back typed, so "what changed?" needs no `git status`. | **55% fewer** round-trips (11 → 5 across 5 common tasks) |
| ♻️&nbsp;**Checkpoint & roll back** | `sh_checkpoint` / `sh_restore` wrap a risky refactor in an undo — a copy-on-write clone on APFS. | clone **~1.5× faster, ~0 MB** vs a 60 MB rsync copy |
| 🔒&nbsp;**Kernel sandbox** | `sandbox: true` confines writes to cwd + temp (optionally no network) — and **refuses to run** rather than go unconfined. | **5 / 5** escape attempts blocked (in-cwd write still lands) |

And one honesty number — because quiet must never mean dishonest: a failure buried in
the hidden middle of a long log is still surfaced, at **100% recall** on a labeled
corpus (`SIGSEGV`, `CONFLICT`, `! [rejected]`, `timed out`, …, none of which contain
the word "error").

Everything else — quieter output, addressable detail, retry, blast-radius
classification — is genuine convenience on top, not the moat.

## Quickstart

No clone, no build — runs via `npx`:

```bash
claude mcp add veil -- npx -y veil-mcp
npx -y veil-mcp init     # adds the "prefer sh_run" nudge to this project's CLAUDE.md
```

<details><summary>Other agents (Cursor, Windsurf, Zed) · from source</summary>

```jsonc
// MCP server config for any MCP-speaking agent
{ "mcpServers": { "veil": { "command": "npx", "args": ["-y", "veil-mcp"] } } }
```

```bash
# from source
git clone https://github.com/vkmtx/veil-mcp && cd veil-mcp
npm install                          # builds dist/ via the prepare script
claude mcp add veil -- node "$(pwd)/dist/index.js"
# dev, no build step:  npm run dev    (tsx src/index.ts)
```

`npx -y github:vkmtx/veil-mcp` runs straight from GitHub. `veil init` is idempotent and
touches only `CLAUDE.md` — see [Adoption](#adoption).
</details>

## The tools

| Tool | What it does |
|------|--------------|
| **`sh_run`** | Run a command → quiet structured result: exit, duration, files changed, token-aware stdout/stderr. The workhorse. |
| **`sh_detail`** | Pull the full stored output of a past run by id — no re-run. Disk-backed, so it survives a server restart. `match=<regex>` greps the stored stream for a value condensing hid. |
| **`sh_plan`** | Predict a command's blast radius (read-only → destructive) **without running it**. |
| **`sh_checkpoint` / `sh_restore`** | Snapshot a directory and roll back. Restore refuses a target dir different from where the checkpoint was taken. |
| **`sh_checkpoints`** | List checkpoint labels. |
| **`sh_history`** | Descriptive aggregates over past runs of a command — observed exit / retry / duration `p50`/`p90` / file-churn, with explicit `n` and recency window. Not a prediction, no causation. |

## See it

```jsonc
// build AND verify the artifact exists — one call, no follow-up ls
sh_run { "command": "npm run build", "expect": { "exit": 0, "file_exists": "dist/index.js" } }

// check blast radius before running (git is classified per-subcommand)
sh_plan { "command": "git push --force" }            // → { category: "destructive", … }

// confine a risky script to cwd, deny network, block reads of secret dirs
sh_run { "command": "./untrusted.sh", "sandbox": { "network": false, "protect_secrets": true } }

// dry-run in a CoW clone — see the cwd-relative diff, real cwd untouched
sh_run { "command": "rm -rf build && npm run generate", "preview": true }

// is this command historically slow/flaky here? (descriptive, not a prediction)
sh_history { "command": "npm test" }

// undo a refactor
sh_checkpoint { "label": "pre-refactor" }
sh_restore   { "label": "pre-refactor" }

// find a value a condensed 50k-line log hid — no re-run, no full dump
sh_detail { "id": "cmd9", "selector": "stdout", "match": "ERROR|version=" }
```

<details><summary><b>All <code>sh_run</code> options</b> — expect, sandbox, retry, trace, …</summary>

| Option | Effect |
|--------|--------|
| `command` | The shell command (required). |
| `cwd` | Working directory (defaults to the server's cwd). |
| `full` | Return uncondensed stdout/stderr inline (escape hatch from condensing). |
| `timeout_ms` | Per-command timeout (default 120s). On expiry the whole **process group** is killed (SIGTERM→SIGKILL), so a compound command's grandchildren (`sleep 5; …`) are reaped too. |
| `expect` | Post-conditions verified in the same call: `exit`, `stdout_contains`, `stdout_matches`, `stderr_empty`, `file_exists`, `file_absent`, `changed`, `max_ms`. Failures surface in `assert_ok` + `assertions_failed` — no second `ls`/`grep`/`git status`. |
| `retries` / `retry_on_exit` / `backoff_ms` | Declarative retry; `attempts` is reported when > 1. |
| `sandbox` | Real OS sandbox. `true` confines file **writes** to cwd + temp; `{ network: false }` also denies network; `{ writable: [...] }` adds roots. `{ protect_secrets: true }` or `{ deny_read: [...] }` also **blocks reads** of configured secret dirs (`~/.ssh`, `~/.aws`, …) — macOS `deny file-read*`, Linux `--tmpfs` mask; sets `secrets_protected: <n>`. Scoped: it blocks the **listed** paths, not a proof against all exfiltration. **Refuses to run** if unavailable — never executes unconfined. Sets `sandboxed: true`. |
| `preview` | **Dry-run in a disposable CoW clone of cwd** — the command runs *inside* the clone, you get the cwd-relative `files_changed`, and the real cwd is **never touched** (nothing is promoted). Honest scope: absolute-path / parent-dir / network effects are **not** captured and may happen for real — this is **not** a sandbox (combine with `sandbox:true` for containment). **Refuses** if the cwd can't be cloned. Sets `preview: true` + `preview_warning`. |
| `trace` | Structured FS/syscall trace (Linux `strace`). Surfaces `trace_summary` (paths read/written + syscall count); full trace via `sh_detail selector=trace`. Best-effort: no tracer → command still runs, `trace_unavailable: true`. |

</details>

<details><summary><b>Result fields</b> — emitted only when relevant (the quiet contract)</summary>

`id`, `exit`, `ok`, `ms`; then `attempts`, `stdout_lines`/`stderr_lines` (TRUE emitted
counts), `files_changed`, `timed_out`, `stdout_truncated`/`stderr_truncated`,
`stdout_binary`/`stderr_binary`, `sandboxed`, `secrets_protected`,
`preview`/`preview_method`/`preview_warning`, `trace_summary`/`trace_unavailable`,
`assert_ok`/`assertions_failed`, `advice`, `hint`, and the condensed `stdout`/`stderr`.

</details>

<details><summary><b>Configuration</b> — every tunable is an env var, no rebuild</summary>

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
| `VEIL_STATE_DIR` | auto | record store base (`$XDG_STATE_HOME/veil` → `~/.local/state/veil` → `$TMPDIR/veil`). `none`/`off` = memory-only |
| `VEIL_RECORD_TTL_MS` | 86400000 | persisted records older than this are pruned on boot (0 = keep) |
| `VEIL_EFFECTS` | true | compute the git effect-diff (set `0` to skip in huge repos) |

</details>

## Output honesty

Condensing saves tokens, but it must never hide signal. So:

- A failure buried mid-stream is **surfaced** — including crash idioms with no
  error/fail keyword (`Segmentation fault`, `SIGSEGV`, `CONFLICT`, `! [rejected]`,
  `undefined reference`, `timed out`). More distinct signals than fit inline? The
  marker reports the **true total** with a `+N more` note, never a silent cap.
  Best-effort, but **measured: 100% recall** on a labeled corpus (see [below](#reproduce-every-number)).
- A byte-capped stream is **labeled** and never shows its tail as the head.
- `stdout_lines`/`stderr_lines` are the **true emitted** count; binary output is
  base64-flagged, not mangled to mojibake.
- `advice` never blocks — it nudges on the highest-signal issue (widen a sandbox
  denial, checkpoint before an unconfined destructive command, use raw Bash for an
  interactive tool).

## Safety

`sh_run` runs **arbitrary shell commands** with your privileges, and exposes the
server's full environment (secrets included) to them. It's a shell — run it in trusted
contexts. Two opt-in layers harden the risky cases:

- **Kernel sandbox** (`sandbox: true`) — *the real boundary.* Confines writes to
  cwd + temp via macOS `sandbox-exec` (Linux bubblewrap, experimental), optionally
  denies network, and **refuses to run** rather than go unconfined. Honest scope:
  solid on macOS; Linux bwrap needs unprivileged user namespaces, which containers /
  Codespaces / Ubuntu 24.04+ often restrict — there it's probed lazily and reports
  unavailable (a namespace-free Landlock backend is planned). The default
  non-sandboxed path works everywhere.
- **Guard hook** (`hooks/veil-guard.sh`) — a **routing nudge, not a security
  boundary.** It steers verbose/dangerous Bash toward `sh_run`, but it is fail-open
  and `VEIL_BYPASS`-able and never stops a command from running. Real containment is
  the sandbox above.

<details><summary>Enable the guard hook</summary>

A `PreToolUse` guard that hard-blocks only **verbose** (installs / builds / test
runners) or **dangerous** (`rm -rf`, `dd`, `mkfs`, `shred`, `find -delete`, raw-device
writes) Bash, steering it to `sh_run`. Commands `sh_run` *can't* help with are
explicitly **allowed** through to raw Bash: long-running `dev`/`watch`/`start` servers,
backgrounded jobs (trailing `&`), process management (`kill`/`pkill`), and
interactive/TTY tools (`vim`/`less`/`top`/`tail -f`). It is **fail-open** (any parse
error → allow, so a bug can never block all Bash), with an escape hatch: prefix a
command with `VEIL_BYPASS=1` to force raw Bash. Enable globally in
`~/.claude/settings.json`:

```jsonc
{ "hooks": { "PreToolUse": [
  { "matcher": "Bash",
    "hooks": [{ "type": "command",
      "command": "/bin/sh '/ABSOLUTE/PATH/veil-mcp/hooks/veil-guard.sh'" }] }
] } }
```

Takes effect on the next Claude Code restart. Remove the entry to disable.
</details>

### Adoption

veil is **opt-in and complements** Bash — its value lands only when the agent actually
reaches for `sh_run`, and an agent left to itself often defaults to raw Bash. Two levers
close that gap: the **nudge** (`veil init` writes a short `CLAUDE.md` block — soft,
zero-friction) and the **guard hook** (stronger, per-machine). There's no native
integration yet, so one must be configured; or skip both and call `sh_run` directly.

## Reproduce every number

Don't take the numbers on trust — no account, all local:

```bash
git clone https://github.com/vkmtx/veil-mcp && cd veil-mcp && npm install
npm test          # 228 smoke assertions over a live stdio server (some platform-gated)
npm run metrics   # the value numbers below
npm run backtest  # byte-savings regression (bulk-condense ratio + per-command overhead floor)
npm run bench     # detailed 5-dimension benchmark (economy, latency, per-feature, condense, session)
```

| Metric | Result | What it measures |
|--------|--------|------------------|
| **Agent turns saved** | **55% fewer** round-trips (11 → 5) | MCP calls collapsed by `expect` + effects + retry across 5 common tasks — counts *calls*, not bytes, so it holds as context windows grow |
| **Sandbox escapes blocked** | **5 / 5** | adversarial outside-cwd / spawned-child / symlink / network writes denied by the kernel; a legitimate in-cwd write still lands (selective, not deny-all) |
| **Signal recall** | **100%** on 10 fixtures | buried failures surfaced from the elided middle, incl. non-keyword crash idioms |
| **Checkpoint cost** | clone **~1.5× faster, ~0 MB** vs rsync 60 MB | CoW clone latency + disk vs the rsync mirror (macOS / same-volume APFS) |

The deterministic rows (turns, recall) are asserted in the smoke suite from the same
fixtures, so the published figures can't silently drift. Timing rows are
machine-dependent. CI runs the whole suite on macOS **and** Linux (with bubblewrap +
strace), so the Linux-only sandbox and trace paths are exercised too.

<details><summary>Roadmap &amp; architecture</summary>

| | Feature | Status |
|---|---------|--------|
| **I / J / H** | token-aware output · addressable detail (`sh_detail`, `match`) · effect diff | ✅ done |
| **G / M** | inline assertions (`expect`) · declarative retry/timeout | ✅ done |
| **B / K-lite** | static safety pre-check + classification (`sh_plan`) | ✅ done |
| **C / C+** | checkpoint / rollback · atomic CoW clone (same-volume APFS; cross-volume falls back to rsync, reported honestly) | ✅ done |
| **K** | real sandbox (macOS `sandbox-exec`) | ✅ done |
| **J+** | disk-backed record store (survives restart, TTL-pruned) | ✅ done |
| **K+ / A** | Linux sandbox (bubblewrap) · structured trace (`strace`) | 🧪 experimental — validated on Linux CI |
| **K++** | namespace-free Linux sandbox (Landlock) — covers containers/Codespaces | 🔭 planned |
| — | streaming / PTY + background jobs | 🔭 planned |

See [CHANGELOG.md](CHANGELOG.md) for version history and [ARCHITECTURE.md](ARCHITECTURE.md)
for the module/feature map. (Why an MCP server and not a shell fork? Most of the value
is a presentation/orchestration layer that ships natively to how an LLM already consumes
tools — in weeks, not a 200k-line C fork — and the kernel/FS bits, veil *drives* rather
than reimplements.)
</details>

## Community

Early project, good time to shape it:

- 💬 **[Discussions](https://github.com/vkmtx/veil-mcp/discussions)** — questions, ideas, show-and-tell
- 🐛 **[Issues](https://github.com/vkmtx/veil-mcp/issues)** — bugs & feature requests (templates provided)
- 🌱 **[Good first issues](https://github.com/vkmtx/veil-mcp/labels/good%20first%20issue)** — scoped first PRs
- 📖 **[CONTRIBUTING.md](CONTRIBUTING.md)** · 🤝 **[Code of Conduct](CODE_OF_CONDUCT.md)**

## License

MIT — see [LICENSE](LICENSE).

---

*v0.5 — experimental, single-author. A security + honesty **hardening pass**
([CHANGELOG](CHANGELOG.md)): 228 smoke assertions + backtest + value metrics, green on
macOS and Linux CI. Judge it by the reproducible suite above, not its age.*
