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
- **`sh_detail selector=stdout`** to recover lines a condensed result hid — never
  re-run a command just to see its output again. Use **`match=<regex>`** to grep the
  stored output for a specific value without dumping it all. (Records are disk-backed,
  so this works even across a server restart.) `id` is optional — omitted, it resolves
  to the most recent run; a wrong one answers with the ids that are addressable.
- **`sh_checkpoint`** before a risky or irreversible change; **`sh_restore`** to
  roll back if it goes wrong. `label` is optional both ways: checkpoints auto-number
  (`auto-1`, `auto-2`, …) and a bare `sh_restore` takes the newest.
- **Whole diffs**: `git diff`/`git show` through `sh_run`, then pull the hunk with
  `sh_detail match=`. A full diff is thousands of tokens of which you read ten lines.
  `--stat`/`--name-only` (or a bounding `| head`) when that is all you need.

Use raw Bash only for trivial, read-only, short-output commands where structure
adds nothing, or for interactive/TTY/streaming commands (`vim`, REPLs) that `sh_run`
cannot drive (it buffers and has no TTY).

## Development

This IS the veil-mcp repo. Before committing, the gate is
`npm run typecheck && npm test && npm run backtest` (all green). New behavior →
a module + a `test/smoke.ts` assertion + green backtest + updated docs. See
[CONTRIBUTING.md](CONTRIBUTING.md).
