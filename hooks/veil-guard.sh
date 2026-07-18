#!/bin/sh
# veil PreToolUse guard (global, opt-in via ~/.claude/settings.json).
#
# Hard-blocks ONLY Bash commands that are clearly VERBOSE (installs/builds/tests)
# or DANGEROUS (recursive delete, force+glob delete, dd, mkfs, raw-device writes),
# steering them to the veil `sh_run` tool (quiet, structured, verifiable,
# addressable output). Everything else is allowed — the soft preference lives in
# CLAUDE.md, the hook only enforces the high-value cases.
#
# Design guarantees:
#   - FAIL-OPEN: any parse error / missing python3 / unexpected input → allow (exit 0).
#     A bug here must never be able to block all Bash.
#   - ESCAPE HATCH: prefix the command with `VEIL_BYPASS=1` to force raw Bash
#     (for interactive/TTY/streaming cases sh_run can't handle).
#   - ONE NAG PER SESSION for the VERBOSE class: the first verbose command in a
#     session blocks with the sh_run steer; after that the model's choice is
#     respected (marker file keyed on session_id). DANGEROUS always blocks.
#   - exit 0 = allow; exit 2 = block (reason on stderr is shown to the agent).

# NOTE: pass the program via -c (NOT `python3 -` with a heredoc, which would consume
# the hook's stdin as the program and never see the JSON).
OUT=$(/usr/bin/python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if d.get("tool_name") != "Bash":
    sys.exit(0)
sid = (d.get("session_id") or "nosession").replace("/", "_")
cmd = d.get("tool_input", {}).get("command", "")
sys.stdout.write(sid + "\t" + cmd)' 2>/dev/null) || exit 0

# Split SID/CMD on the FIRST real tab. NB: in POSIX parameter-expansion patterns
# `\t` is a literal escaped `t`, NOT a tab — the delimiter must be a real tab
# character, quoted so it is matched literally. A UUID session_id can never
# contain a tab, so the first tab is always the delimiter (and `#` takes the
# shortest prefix, so a command that itself contains tabs survives intact).
TAB=$(printf '\t')
SID=${OUT%%"$TAB"*}
CMD=${OUT#*"$TAB"}

# No command extracted, or python3 unavailable → fail open.
[ -n "$CMD" ] || exit 0

# Explicit bypass — honored ONLY as a LEADING environment assignment (the
# documented "prefix the command with VEIL_BYPASS=1" escape hatch). A plain
# substring match let a trailing comment defeat the guard entirely, e.g.
# `rm -rf / # VEIL_BYPASS=1` would slip through.
bypass_head=$(printf '%s' "$CMD" | sed 's/^[[:space:]]*//')
case "$bypass_head" in
  VEIL_BYPASS=1|VEIL_BYPASS=1[[:space:]]*) exit 0 ;;
esac

# Dangerous: RECURSIVE delete (recursion is the blast radius, not -f: a single-file
# `rm -f build.log` passes; force+GLOB still blocks), content shredding, raw-device /
# filesystem writes. Verb-led patterns (rm/shred/truncate) are anchored to EXECUTABLE
# position — start of command, just after a shell operator (| ; & ( { and the 2nd char of
# && / ||), or after a command runner/keyword (the classify.ts WRAPPERS set + do/then/else)
# — so the same word as an argument or inside a quote (`echo rm -rf x`, `grep "rm -rf" f`,
# `cat shred.log`) is NOT mis-blocked, while `sudo rm -rf /`, `timeout 5 rm -rf x`, and
# `; do rm -rf x` still block. The rest stay operator-bounded so a match can't cross into
# an unrelated command. Blocked even if backgrounded — ALWAYS.
# rm at EXECUTABLE position: an exec anchor (start / operator / `{`), then ZERO OR MORE
# command runners — a WRAPPER word plus its own flag/number args (`timeout 5`, `ionice -c3`,
# `nice -n 10`) — then `rm`. The arg tokens are restricted to `-…`/digit so the greedy match
# can never swallow the `rm` itself. `rm` as a plain argument (`echo rm -rf`) has no wrapper
# chain and no anchor → not matched.
RMPFX='(^|[|;&({])[[:space:]]*((sudo|doas|env|nice|nohup|command|timeout|time|stdbuf|setsid|ionice|xargs|busybox|do|then|else)[[:space:]]+((-[^|;&()[:space:]]*|[0-9][^|;&()[:space:]]*)[[:space:]]+)*)*rm'
if printf '%s' "$CMD" | grep -Eq \
  -e "${RMPFX}[[:space:]]+([^|;&]*[[:space:]])?-[a-zA-Z]*[rR]" \
  -e "${RMPFX}\b[^|;&]*--recursive\b" \
  -e "${RMPFX}\b[^|;&]*-[a-zA-Z]*f[^|;&]*[[:space:]][^|;&[:space:]]*\*" \
  -e '\bgit[[:space:]]+clean\b[^|;&]*[[:space:]](-[a-z]*f|--force)' \
  -e '\bfind\b[^|;&]*[[:space:]]-delete\b' \
  -e '\bfind\b[^|;&]*-exec[[:space:]]+rm\b' \
  -e '\bchmod\b[^|;&]*[[:space:]](-[a-z]*R|--recursive)' \
  -e '(^|[|;&(])[[:space:]]*shred\b' \
  -e '(^|[|;&(])[[:space:]]*truncate\b' \
  -e '[[:space:]]>[[:space:]]*/dev/(sd|disk|hd|nvme|vd|mapper)' \
  -e '\bdd[[:space:]]' \
  -e '\bmkfs'; then
  echo 'veil: dangerous command — retry EXACTLY as sh_run {"command":"<this same command string>","sandbox":true} (or sh_checkpoint first). Only required key: "command" (string). Prefix VEIL_BYPASS=1 only if sh_run genuinely cannot run it.' >&2
  exit 2
fi

# ALLOW (sh_run can't help): long-running servers, watch/dev, backgrounded jobs,
# process management, and interactive/TTY tools. sh_run blocks until exit and has no
# TTY/background, so forcing it here would only break the flow — let these be raw Bash.
if printf '%s' "$CMD" | grep -Eq '&[[:space:]]*$|\b(dev|serve|watch|preview|start)\b|--watch\b|\b(kill|pkill|killall|pgrep|pidof|nohup|disown)\b|\b(nodemon|concurrently|vim|vi|nano|emacs|less|more|most|top|htop|man)\b|\btail[[:space:]]+-f\b'; then
  exit 0
fi

# Verbose: package managers / builds / test runners — sh_run condenses these massively.
# Modern tools (bun/deno/uv) and image builds (docker build / compose build) are just as
# verbose as npm/pip. Note `docker ps|logs|run` and `docker compose up` are NOT matched here
# — they are read-only or long-running and fall through to the allow path / raw Bash.
# ONE NAG PER SESSION: after the first block the model has been told; further verbose
# commands in the same session are allowed (the CLAUDE.md soft preference still applies).
MARK="${TMPDIR:-/tmp}/veil-guard-verbose-$SID"
if printf '%s' "$CMD" | grep -Eq '\b(npm|pnpm|yarn|bun|deno|uv|pip|pip3|cargo|go|gradle|mvn|bundle|composer|gem)\b[^|;&]*\b(install|i|ci|add|build|test|run|sync)\b|\b(make|tsc|webpack|vite|rollup|esbuild|pytest|jest|vitest|mocha)\b|\bdocker(-compose|[[:space:]]+compose)?[[:space:]]+(build|buildx)\b'; then
  [ -e "$MARK" ] && exit 0           # already nagged this session — respect the model's choice
  : > "$MARK" 2>/dev/null || true    # marker write failure = still nag (fail toward nudge, never toward block-loop)
  echo 'veil: verbose command (one nag per session) — retry EXACTLY as sh_run {"command":"<this same command string>","expect":{"exit":0}}. The only required key is "command" (a string; NOT cmd). Full output later via sh_detail. Prefix VEIL_BYPASS=1 to force Bash.' >&2
  exit 2
fi

exit 0
