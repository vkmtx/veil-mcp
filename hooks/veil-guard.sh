#!/bin/sh
# veil PreToolUse guard (global, opt-in via ~/.claude/settings.json).
#
# Hard-blocks ONLY Bash commands that are clearly VERBOSE (installs/builds/tests)
# or DANGEROUS (recursive force-delete, dd, mkfs, raw-device writes), steering them
# to the veil `sh_run` tool (quiet, structured, verifiable, addressable output).
# Everything else is allowed — the soft preference lives in CLAUDE.md, the hook only
# enforces the high-value cases.
#
# Design guarantees:
#   - FAIL-OPEN: any parse error / missing python3 / unexpected input → allow (exit 0).
#     A bug here must never be able to block all Bash.
#   - ESCAPE HATCH: prefix the command with `VEIL_BYPASS=1` to force raw Bash
#     (for interactive/TTY/streaming cases sh_run can't handle).
#   - exit 0 = allow; exit 2 = block (reason on stderr is shown to the agent).

# NOTE: pass the program via -c (NOT `python3 -` with a heredoc, which would consume
# the hook's stdin as the program and never see the JSON).
CMD=$(/usr/bin/python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if d.get("tool_name") != "Bash":
    sys.exit(0)
print(d.get("tool_input", {}).get("command", ""))' 2>/dev/null) || exit 0

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

# Dangerous: recursive/force delete, content shredding, raw-device / filesystem
# writes. Each alternative is bounded by [^|;&] so a match can't cross a shell
# operator into an unrelated command. Blocked even if backgrounded.
if printf '%s' "$CMD" | grep -Eq \
  -e '\brm[[:space:]]+([^|;&]*[[:space:]])?-[a-z]*[rf]' \
  -e '\brm\b[^|;&]*--(recursive|force)\b' \
  -e '\bgit[[:space:]]+clean\b[^|;&]*[[:space:]](-[a-z]*f|--force)' \
  -e '\bfind\b[^|;&]*[[:space:]]-delete\b' \
  -e '\bfind\b[^|;&]*-exec[[:space:]]+rm\b' \
  -e '\bchmod\b[^|;&]*[[:space:]](-[a-z]*R|--recursive)' \
  -e '\bshred\b' \
  -e '\btruncate[[:space:]]' \
  -e '[[:space:]]>[[:space:]]*/dev/(sd|disk|hd|nvme|vd|mapper)' \
  -e '\bdd[[:space:]]' \
  -e '\bmkfs'; then
  echo "veil: dangerous command — use sh_run (optionally sandbox:true / sh_checkpoint first), or prefix VEIL_BYPASS=1 to force Bash." >&2
  exit 2
fi

# ALLOW (sh_run can't help): long-running servers, watch/dev, backgrounded jobs,
# process management, and interactive/TTY tools. sh_run blocks until exit and has no
# TTY/background, so forcing it here would only break the flow — let these be raw Bash.
if printf '%s' "$CMD" | grep -Eq '&[[:space:]]*$|\b(dev|serve|watch|preview|start)\b|--watch\b|\b(kill|pkill|killall|pgrep|pidof|nohup|disown)\b|\b(nodemon|concurrently|vim|vi|nano|emacs|less|more|most|top|htop|man)\b|\btail[[:space:]]+-f\b'; then
  exit 0
fi

# Verbose: package managers / builds / test runners — sh_run condenses these massively.
if printf '%s' "$CMD" | grep -Eq '\b(npm|pnpm|yarn|pip|pip3|cargo|go|gradle|mvn|bundle|composer|gem)\b[^|;&]*\b(install|i|ci|add|build|test|run)\b|\b(make|tsc|webpack|vite|rollup|esbuild|pytest|jest|vitest|mocha)\b'; then
  echo "veil: verbose command — prefer sh_run (quiet structured result; full output via sh_detail). Add expect to verify in one call. Prefix VEIL_BYPASS=1 to force Bash." >&2
  exit 2
fi

exit 0
