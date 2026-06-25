# Roadmap

Status legend: ✅ done · 🧪 experimental · 🔭 planned

| Feature | Status |
|---------|--------|
| token-aware rendering | ✅ |
| addressable output store (`sh_detail`, `match`) | ✅ |
| disk-backed record store (survives restart, TTL-pruned) | ✅ |
| effects-as-data diff (git porcelain / trace-derived) | ✅ |
| inline assertions (`expect`) | ✅ |
| declarative retry / timeout | ✅ |
| dry-run plan + static classification (`sh_plan`, segment-aware) | ✅ |
| checkpoint / rollback | ✅ |
| atomic CoW checkpoints (APFS `clonefile`) | ✅ |
| real sandbox enforcement (macOS `sandbox-exec`) | ✅ |
| `veil init` zero-friction setup | ✅ |
| Linux sandbox (bubblewrap) | 🧪 needs unprivileged userns |
| structured syscall trace (Linux `strace`) | 🧪 |
| namespace-free Linux sandbox (Landlock) — covers containers/Codespaces | 🔭 [#9](https://github.com/vkmtx/veil-mcp/issues/9) |
| background jobs (`sh_logs` / `sh_stop`) for dev servers / watchers | 🔭 [#10](https://github.com/vkmtx/veil-mcp/issues/10) |

### Known platform risk: macOS sandbox-exec deprecation

The macOS sandbox backend relies entirely on `sandbox-exec`, which Apple has
deprecated. It is the only sandbox mechanism on macOS today.

Why this is currently safe: the honesty contract is fail-closed. If `sandbox-exec`
is unavailable, a `sandbox:true` request **refuses to run** rather than executing
unconfined — a command is never silently downgraded to an unsandboxed run.

User-visible impact if a future macOS removes it: macOS users would have **no**
sandbox at all. Every `sandbox:true` call would refuse, and write-confinement /
network-deny / secret read-confine would be unavailable on the platform.

Candidate fallbacks to evaluate:

- **Endpoint Security framework** — finer-grained, but needs a provisioned Apple
  entitlement (and the distribution/signing that implies).
- **Container- or VM-based confinement** — heavier, but does not depend on a
  deprecated host primitive.
- At minimum, a **loud capability banner** so users know confinement is gone and
  are not lulled by a silent loss of protection.

## How to help

- 🌱 [Good first issues](https://github.com/vkmtx/veil-mcp/labels/good%20first%20issue)
- 🙌 [Help wanted](https://github.com/vkmtx/veil-mcp/labels/help%20wanted)
- 💬 Propose ideas in [Discussions](https://github.com/vkmtx/veil-mcp/discussions)

See [CHANGELOG.md](https://github.com/vkmtx/veil-mcp/blob/main/CHANGELOG.md) for shipped
versions.
