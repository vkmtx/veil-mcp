# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/vkmtx/veil-mcp/security/advisories/new)
instead of opening a public issue. I aim to acknowledge within a few days.

## Threat model

`sh_run` executes arbitrary shell commands with the privileges of the process that
launched the MCP server, and exposes its environment — including any secrets in
environment variables — to those commands. This is by design: it is a shell. Run it
only in trusted contexts.

The optional `sandbox` option provides best-effort kernel confinement (macOS
`sandbox-exec`; Linux bubblewrap) and **refuses to run** rather than executing
unconfined when confinement is requested but unavailable. The static `sh_plan`
classifier is an advisory pre-check, not an enforcement boundary — never rely on it
alone to gate a destructive command.

## Supported versions

Pre-1.0 and experimental: only the latest release receives fixes.
