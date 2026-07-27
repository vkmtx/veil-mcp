# FAQ

### Does it replace Bash?

No. veil is opt-in and complementary. Use `sh_run` for effect-bearing or verbose
commands; keep raw Bash for trivial read-only or interactive/TTY commands (REPLs,
`vim`, `tail -f`) that `sh_run` can't drive (it buffers and has no TTY).

### How does the agent know to use it?

It doesn't, by default — adoption depends on a nudge (`veil init` writes one into
`CLAUDE.md`) or the guard hook. There is no native integration; `veil init` reduces
setup to one command but doesn't remove the step. See [[Installation]].

### Where did `sh_plan` and `sh_history` go?

Removed in 0.8.0. A 30-day audit of real Claude Code session logs measured **0 calls** to
either across 3.5k sessions, against 3.5k calls to `sh_run`. Every tool occupies a slot in
the agent's context on every single request, so a tool nobody calls is a permanent tax.
The blast-radius classifier behind `sh_plan` is unchanged and still gates every `sh_run`.

### Is the blast-radius classification a real dry-run?

No — it's **static** classification, not execution. Shell is Turing-complete, so a
genuine universal dry-run is impossible (`curl | sh` can't be predicted). It decomposes
pipelines/lists and classifies each segment, biasing toward over-flagging. Treat it as
advisory, never as an enforcement boundary. For an actual dry-run use `sh_run` with
`preview: true`; for containment use `sandbox: true`.

### Will I lose `sh_detail` history if the server restarts?

No. Records are persisted to disk (per project) and recovered on restart. Old records
are TTL-pruned and capped by `VEIL_MAX_RECORDS`. See [[Configuration]].

### Does the sandbox work in Docker / Codespaces?

Often not — those environments restrict the unprivileged user namespaces bubblewrap
needs, so `sandbox` reports unavailable and refuses (rather than running unconfined).
macOS is solid. A Landlock backend is planned for the container case. See
[[Sandbox and Trace]].

### Is it safe? It runs arbitrary shell commands.

`sh_run` executes arbitrary commands with the launching process's privileges and
exposes its environment (including secrets) — by design, it is a shell. Run it only in
trusted contexts. For a single risky command, opt into `sandbox`. See the
[security policy](https://github.com/vkmtx/veil-mcp/blob/main/SECURITY.md).

### How much does it actually save on tokens?

The verbose-case savings are large (the backtest floors each verbose case at 85% and
the weighted mix at 70%), but the real value is structure + safety, not the token
count. Reproduce the numbers yourself: `npm test && npm run bench`.

### Which platforms are supported?

macOS and Linux. The default (non-sandbox) path is cross-platform; the Linux sandbox
and trace backends are experimental and validated in CI.
