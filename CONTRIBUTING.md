# Contributing

veil-mcp is a small, single-package TypeScript MCP server. The bar is: every
change is **typed, tested, and honest** (economy never costs the agent quality).

## Setup

```bash
npm install
npm run dev          # run the server over stdio (tsx, no build)
```

## The gate (run before every commit)

```bash
npm run typecheck    # tsc --noEmit — must be clean
npm test             # test/smoke.ts — end-to-end over a live stdio server
npm run backtest     # test/backtest.ts — token-savings must stay above the floor
```

`npm run bench` gives a detailed 5-dimension benchmark (economy, latency,
per-feature cost, condense ratio, session model) — run it when changing the hot path.

## Conventions

- **New behavior → a new module + a `test/smoke.ts` assertion + green backtest +
  updated docs (README/ARCHITECTURE/CHANGELOG).** Keep modules single-responsibility
  (see [ARCHITECTURE.md](ARCHITECTURE.md)).
- **stdout is the MCP channel** — all logging goes to stderr.
- **Quiet on success, generous on failure; never dishonest.** A condensed view must
  always carry an `sh_detail` pointer, surface mid-stream signal, and tell the truth
  about truncation, line counts, and binary content.
- **Safety features fail-closed; observability fails-open.** A sandbox refuses when
  unavailable (never runs unconfined); a trace degrades (the command still runs).
- **Platform-specific paths are guarded and exercised in CI.** macOS-only assertions
  guard on `process.platform === "darwin"`; Linux sandbox/trace run on the Ubuntu CI
  leg (with bubblewrap + strace). Don't ship enforcement that no environment tests.

## Tests

`test/smoke.ts` boots the real server over stdio and asserts the tool contract end
to end, plus pure unit checks (render/signals/policy/trace/effects). Add assertions
next to the feature they cover; gate platform-specific ones as above.

## Commits

Conventional-commit style (`feat:`, `fix:`, `perf:`, `bench:`, `docs:`). Explain the
*why* in the body when it isn't obvious.
