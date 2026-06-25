# veil-mcp

An **agent-native shell**, delivered as an [MCP](https://modelcontextprotocol.io)
server. It sits between an LLM agent and the shell and turns command *effects into
data*: quiet structured results, addressable detail pulled on demand, and a real
safety net for risky commands.

> **quiet-by-default · addressable · lazy-detail · structured-replaces-text**

```bash
claude mcp add veil -- npx -y veil-mcp
npx -y veil-mcp init      # drop the "prefer sh_run" nudge into a project's CLAUDE.md
```

## Why

A terminal dumps everything into scrollback; an agent swallows it all, regexes
fragile text, round-trips for state, and has no undo. veil returns typed effects,
stores full output addressably (so it is never re-emitted into context), and offers
opt-in kernel confinement and copy-on-write checkpoints.

The token economy is a **consequence** of returning structure, not the bet — the
structure and safety stay valuable even as context windows grow.

## Pages

- **[[Installation]]** — npm, GitHub, from source, agent config
- **[[Tools Reference]]** — `sh_run`, `sh_detail`, `sh_plan`, checkpoints
- **[[Configuration]]** — every `VEIL_*` environment variable
- **[[Sandbox and Trace]]** — kernel confinement (sandbox enforcement) and FS tracing (structured syscall trace)
- **[[FAQ]]** — common questions and honest limits
- **[[Roadmap]]** — what's done and what's planned

## Links

- 📦 npm: https://www.npmjs.com/package/veil-mcp
- 🧱 Source + ARCHITECTURE.md: https://github.com/vkmtx/veil-mcp
- 💬 Discussions: https://github.com/vkmtx/veil-mcp/discussions
- 🌱 Good first issues: https://github.com/vkmtx/veil-mcp/labels/good%20first%20issue
