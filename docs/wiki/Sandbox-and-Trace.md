# Sandbox and Trace

Both are **opt-in** per `sh_run` call. The default path uses neither and works
everywhere.

## Sandbox (kernel enforcement)

Real kernel-level write confinement for a single risky command. `sh_run`'s `sandbox`
option:

```jsonc
sh_run { "command": "./untrusted.sh", "sandbox": true }                    // writes confined to cwd + temp
sh_run { "command": "./untrusted.sh", "sandbox": { "network": false } }    // also deny network
sh_run { "command": "./gen.sh",       "sandbox": { "writable": ["out"] } } // extra writable root
```

`network: false` unshares the network namespace (no TCP/UDP). On Linux the bubblewrap
backend additionally masks `/run` and `/var/run` with tmpfs, so a Docker/Podman Unix
socket on the bound filesystem isn't a way around the network deny.

**Honesty contract:** if a sandbox is requested but unavailable, `sh_run` **refuses to
run** rather than executing unconfined (sets `sandbox_unavailable: true`).

### Portability — honest, not universal

| Platform | Backend | Status |
|----------|---------|--------|
| macOS | `sandbox-exec` (Seatbelt/SBPL) | solid |
| Linux (bare/VM) | bubblewrap (`bwrap`) | experimental; needs unprivileged user namespaces |
| Containers / Codespaces / Ubuntu 24.04+ | — | often unavailable (userns restricted); `sandbox` self-tests at startup and reports unavailable |

A namespace-free Linux backend via **Landlock** is on the [[Roadmap]] to cover the
container case. The sandbox is an opt-in best-effort layer, not a headline guarantee —
it never runs unconfined silently.

## Trace (structured syscall trace)

A structured FS/syscall trace, **best-effort** (Linux `strace`):

```jsonc
sh_run { "command": "make", "trace": true }
```

Surfaces `trace_summary` (paths read/written + syscall count); the full trace is
available via `sh_detail selector=trace`. If no tracer is present the command still
runs and `trace_unavailable: true` is set. When tracing, `files_changed` is derived
from the trace and the git diff is skipped.
