# Roadmap

Status legend: ✅ done · 🧪 experimental · 🔭 planned

| | Feature | Status |
|---|---------|--------|
| **I** | token-aware output | ✅ |
| **J** | addressable output (`sh_detail`, `match`) | ✅ |
| **J+** | disk-backed record store (survives restart, TTL-pruned) | ✅ |
| **H** | effect diff (git porcelain / trace-derived) | ✅ |
| **G** | inline assertions (`expect`) | ✅ |
| **M** | declarative retry / timeout | ✅ |
| **B / K-lite** | static safety pre-check + classification (`sh_plan`, segment-aware) | ✅ |
| **C** | checkpoint / rollback | ✅ |
| **C+** | atomic CoW checkpoints (APFS `clonefile`) | ✅ |
| **K** | real sandbox (macOS `sandbox-exec`) | ✅ |
| — | `veil init` zero-friction setup | ✅ |
| **K+** | Linux sandbox (bubblewrap) | 🧪 needs unprivileged userns |
| **A** | structured trace (Linux `strace`) | 🧪 |
| **K++** | namespace-free Linux sandbox (Landlock) — covers containers/Codespaces | 🔭 [#9](https://github.com/vkmtx/veil-mcp/issues/9) |
| — | background jobs (`sh_logs` / `sh_stop`) for dev servers / watchers | 🔭 [#10](https://github.com/vkmtx/veil-mcp/issues/10) |

## How to help

- 🌱 [Good first issues](https://github.com/vkmtx/veil-mcp/labels/good%20first%20issue)
- 🙌 [Help wanted](https://github.com/vkmtx/veil-mcp/labels/help%20wanted)
- 💬 Propose ideas in [Discussions](https://github.com/vkmtx/veil-mcp/discussions)

See [CHANGELOG.md](https://github.com/vkmtx/veil-mcp/blob/main/CHANGELOG.md) for shipped
versions.
