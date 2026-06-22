# Configuration

All tunables are environment variables — no rebuild. Set them on the MCP server
process (e.g. in the agent's MCP config `env` block).

| Env var | Default | Meaning |
|---------|---------|---------|
| `VEIL_INLINE_MAX_LINES` | `45` | stdout shorter than this (lines) is returned whole |
| `VEIL_HEAD_LINES` | `20` | lines kept from the top when condensing |
| `VEIL_TAIL_LINES` | `20` | lines kept from the bottom when condensing |
| `VEIL_MAX_LINE_CHARS` | `1000` | max chars of any single inline line (longer → capped with a pointer) |
| `VEIL_STDERR_INLINE_ON_FAIL` | `60` | on failure, show up to this many stderr lines inline |
| `VEIL_TIMEOUT_MS` | `120000` | default per-command timeout (`0` = none) |
| `VEIL_MAX_STREAM_BYTES` | `5000000` | max bytes stored per stream (older dropped) |
| `VEIL_MAX_RECORDS` | `500` | max addressable run records (oldest evicted) |
| `VEIL_STATE_DIR` | auto | on-disk record store base (auto: `$XDG_STATE_HOME/veil` → `~/.local/state/veil` → `$TMPDIR/veil`). `none`/`off` = memory-only |
| `VEIL_RECORD_TTL_MS` | `86400000` | persisted records older than this are pruned on boot (`0` = keep) |
| `VEIL_EFFECTS` | `true` | compute the git effect-diff (set `0` to skip in huge repos) |

## Example (Claude Code MCP config)

```jsonc
{
  "mcpServers": {
    "veil": {
      "command": "npx",
      "args": ["-y", "veil-mcp"],
      "env": {
        "VEIL_INLINE_MAX_LINES": "60",
        "VEIL_EFFECTS": "0"
      }
    }
  }
}
```

## The on-disk store

Run records (for `sh_detail`) are cached in memory and persisted to a per-project
directory under `VEIL_STATE_DIR`, so `sh_detail` survives a server restart. Disk I/O
is best-effort — a read-only filesystem degrades to memory-only and never fails a run.
Set `VEIL_STATE_DIR=none` to disable persistence entirely.
