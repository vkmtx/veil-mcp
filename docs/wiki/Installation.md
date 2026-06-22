# Installation

veil-mcp is an MCP server over stdio. It needs **Node ≥ 18**.

## Claude Code (fastest)

```bash
claude mcp add veil -- npx -y veil-mcp
npx -y veil-mcp init      # writes the "prefer sh_run" nudge into this project's CLAUDE.md
```

`npx` fetches and runs the published package — no clone, no global install.

## Other MCP agents (Cursor, Windsurf, Zed, …)

Add to the agent's MCP server config:

```jsonc
{ "mcpServers": { "veil": { "command": "npx", "args": ["-y", "veil-mcp"] } } }
```

## Without npm (straight from GitHub)

```bash
claude mcp add veil -- npx -y github:vkmtx/veil-mcp
```

The `prepare` script builds `dist/` on install, so this works directly from the repo.

## From source

```bash
git clone https://github.com/vkmtx/veil-mcp && cd veil-mcp
npm install                       # builds dist/ via the prepare script
claude mcp add veil -- node "$(pwd)/dist/index.js"
# dev, no build step:  npm run dev   (tsx src/index.ts)
```

## Making the agent prefer it

veil is opt-in and complementary to Bash — its value only lands when the agent reaches
for `sh_run`. Two levers:

1. **The nudge** — `veil init` writes a short block into the project's `CLAUDE.md`.
2. **The guard hook** — [`hooks/veil-guard.sh`](https://github.com/vkmtx/veil-mcp/blob/main/hooks/veil-guard.sh)
   is a `PreToolUse` guard that steers verbose/dangerous Bash to `sh_run` while letting
   interactive/long-running/background commands through. Fail-open, with a `VEIL_BYPASS=1`
   escape.

See [[FAQ]] for the honest adoption caveats.
