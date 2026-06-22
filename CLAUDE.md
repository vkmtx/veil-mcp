# Nudge for Claude Code

When this MCP server (`veil`) is connected, prefer its tools over raw Bash:

- **`sh_run`** instead of a raw Bash call for any command that changes files
  (build, install, codegen, migrations, `mv`/`rm`/`cp`, formatters) or is likely
  verbose (`npm install`, `pytest`, `cargo build`). It returns a quiet structured
  result and stores full output addressably.
  - Add **`expect`** to verify in the same call (e.g. `{ exit: 0, file_exists: "dist/index.js" }`)
    instead of firing a second `ls`/`grep`/`git status`.
  - Add **`retries`** for known-flaky commands (network installs, etc.).
  - Add **`sandbox: true`** (or `{ network: false }`) to confine a risky/untrusted command.
  - Add **`trace: true`** to capture which files it read/wrote (Linux).
- **`sh_detail id=<id> selector=stdout`** to recover lines a condensed result hid —
  never re-run a command just to see its output again. Use **`match=<regex>`** to
  grep the stored output for a specific value without dumping it all.
- **`sh_plan`** before any destructive or unfamiliar command, to see its predicted
  blast radius without executing it.
- **`sh_checkpoint`** before a risky or irreversible change; **`sh_restore`** to
  roll back if it goes wrong.

Use raw Bash only for trivial, read-only, short-output commands where structure
adds nothing, or for interactive/TTY/streaming commands (`vim`, REPLs) that `sh_run`
cannot drive (it buffers and has no TTY).

## Development

This IS the veil-mcp repo. Before committing, the gate is
`npm run typecheck && npm test && npm run backtest` (all green). New behavior →
a module + a `test/smoke.ts` assertion + green backtest + updated docs. See
[CONTRIBUTING.md](CONTRIBUTING.md).
