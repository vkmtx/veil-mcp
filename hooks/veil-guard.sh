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
#   - MATCH THE CODE, NOT THE PROSE: the classifier below runs on a SANITIZED copy
#     of the command (see the sanitizer contract), so a build word quoted as data
#     or buried in a commit message can never trip it.

# NOTE: pass the program via -c (NOT `python3 -` with a heredoc, which would consume
# the hook's stdin as the program and never see the JSON).
#
# SANITIZER CONTRACT — emits `session_id \t scan`, where `scan` is a single-line,
# match-only rendering of the command. The raw command is never classified directly,
# because every pattern below is about what the shell will EXECUTE, not what the
# string happens to contain:
#   1. Heredoc bodies are dropped (`git commit -F - <<EOF … EOF`): a commit message
#      that mentions "build" or "make" is prose, not a build. A herestring (`<<<"x"`)
#      is NOT a heredoc — without the negative lookahead its 2nd/3rd `<` parse as a
#      `<<` and the whole rest of the command gets swallowed as body text, silently
#      un-scanning the very lines that matter.
#   2. Quoted strings collapse to a neutral ` Q ` token: `grep -E "(tsc|build)" pkg.json`
#      is a search for that text, not an invocation of it.
#   3. Newlines become ` ; ` — every operator-bounded pattern (`[^|;&]*`) then stops at a
#      line break instead of matching across two unrelated commands.
#   4. `rm -rf <build dir>` collapses to ` RMBUILD `: wiping `.next`/`dist`/`coverage`
#      is a regenerable-artifact delete, not data loss, and it is the second half of the
#      dev-server restart idiom (`pkill …; rm -rf .next; nohup next dev …`) — which the
#      DANGEROUS class used to block before the ALLOW list could ever see it. Anything
#      unresolvable (glob, `..`, `~`, `$VAR`, a root-level absolute path, or a single
#      non-build target in the list) is left intact and still blocks.
# TRADEOFF, stated plainly: sanitizing before the DANGEROUS class too means a dangerous
# verb that only ever appears inside quotes (`sh -c "dd if=/dev/zero of=/dev/disk0"`) is
# no longer matched. That is deliberate and consistent with what this hook is — a routing
# nudge, fail-open and VEIL_BYPASS-able, never a security boundary (real containment is
# sh_run sandbox:true). The false positives it removes are not hypothetical: this guard
# blocked the very commit that added its own test corpus, because the heredoc body and the
# quoted `"rm -rf x"` fixtures read as commands.
# NB: the python source is embedded in a single-quoted shell string and therefore may
# not contain a literal apostrophe — hence chr(39).
OUT=$(/usr/bin/python3 -c 'import sys, json, re
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if d.get("tool_name") != "Bash":
    sys.exit(0)
sid = (d.get("session_id") or "nosession").replace("/", "_")
cmd = d.get("tool_input", {}).get("command", "")
SQ = chr(39)
NL = chr(10)
BUILD = set(".next .nuxt .turbo .svelte-kit .astro .expo .vite .parcel-cache .cache .pytest_cache __pycache__ dist build out coverage".split())
HD = re.compile("(?<!<)<<(?!<)-?[ \t]*[" + SQ + "\"]?([A-Za-z_][A-Za-z0-9_]*)")
kept = []
tag = None
for ln in cmd.split(NL):
    if tag is None:
        kept.append(ln)
        m = HD.search(ln)
        if m:
            tag = m.group(1)
    elif ln.strip() == tag:
        tag = None
s = NL.join(kept)
s = re.sub(SQ + "[^" + SQ + "]*" + SQ, " Q ", s)
s = re.sub("\"[^\"]*\"", " Q ", s)
s = s.replace(chr(9), " ").replace(chr(13), " ").replace(NL, " ; ")
def keep_rm(m):
    toks = m.group(2).split()
    targets = [t for t in toks[1:] if not t.startswith("-")]
    if not targets:
        return m.group(0)
    for t in targets:
        if "*" in t or ".." in t or t.startswith("~") or t.startswith("$"):
            return m.group(0)
        p = t.rstrip("/")
        if p.split("/")[-1] not in BUILD:
            return m.group(0)
        if p.startswith("/") and p.count("/") < 3:
            return m.group(0)
    return m.group(1) + " RMBUILD "
s = re.sub("(^|[|;&({])([ \t]*rm[ \t]+[^|;&()]*)", keep_rm, s)
sys.stdout.write(sid + "\t" + s)' 2>/dev/null) || exit 0

# Split SID/SCAN on the FIRST real tab. NB: in POSIX parameter-expansion patterns
# `\t` is a literal escaped `t`, NOT a tab — the delimiter must be a real tab
# character, quoted so it is matched literally. A UUID session_id can never
# contain a tab, and the sanitizer strips tabs out of the command, so the first
# tab is always the delimiter.
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
# — so the same word as an argument (`echo rm -rf x`, `cat shred.log`) is NOT mis-blocked,
# while `sudo rm -rf /`, `timeout 5 rm -rf x`, and `; do rm -rf x` still block. The rest
# stay operator-bounded so a match can't cross into an unrelated command. Blocked even if
# backgrounded — ALWAYS.
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
  echo 'veil: dangerous command — retry EXACTLY as sh_run {"command":"<this same command string>"}. Only required key: "command" (string). Add "sandbox":true ONLY if the command must not write outside cwd (it refuses to run when no sandbox is available); sh_checkpoint first if you may need to roll back. Prefix VEIL_BYPASS=1 only if sh_run genuinely cannot run it.' >&2
  exit 2
fi

# EXECUTABLE POSITION, same idea as RMPFX: a tool name only counts when it is what the
# shell RUNS. An unanchored `\b(make|tsc|vitest|…)\b` matched the word anywhere and blocked
# read-only greps (`grep -rn "HttpApiGroup.make" src`) and package.json lookups. EXPFX adds
# the runner chain (incl. `npx`/`bunx`/`uvx`, so `npx vitest run` still matches) plus an
# optional path prefix, so `./node_modules/.bin/vitest` and `/usr/bin/make` still match
# while `HttpApiGroup.make` — no anchor, no trailing slash — does not. Shared by the ALLOW
# and VERBOSE classes below.
EXPFX='(^|[|;&({])[[:space:]]*((sudo|doas|env|nice|nohup|command|timeout|time|stdbuf|setsid|ionice|xargs|busybox|npx|bunx|pnpx|uvx|pipx|do|then|else)[[:space:]]+((-[^|;&()[:space:]]*|[0-9][^|;&()[:space:]]*)[[:space:]]+)*)*([A-Za-z0-9._~+/-]*/)?'

# ALLOW (sh_run can't help): long-running servers, watch/dev, backgrounded jobs,
# process management, and interactive/TTY tools. sh_run blocks until exit and has no
# TTY/background, so forcing it here would only break the flow — let these be raw Bash.
#
# The dev/serve/watch/preview/start words are anchored to a RUN TARGET (a package-manager
# script name or a dev-server binary's subcommand). Unanchored `\b(dev|start|…)\b` matched
# those words ANYWHERE in the string, and since ALLOW short-circuits the whole guard, one
# branch named `dev` disabled it for the entire command: `git diff dev..feat` (and any
# verbose command mentioning a dev/preview branch or path) sailed through. Bare `--watch`
# stays unanchored — it is a flag, so it can only be one.
if printf '%s' "$CMD" | grep -Eq \
  -e '&[[:space:]]*$' \
  -e '--watch\b' \
  -e '\b(kill|pkill|killall|pgrep|pidof|nohup|disown)\b' \
  -e '\b(nodemon|concurrently|vim|vi|nano|emacs|less|more|most|top|htop|man)\b' \
  -e '\btail[[:space:]]+-f\b' \
  -e "${EXPFX}(npm|pnpm|yarn|bun|deno)[[:space:]]+(run[[:space:]]+)?(dev|serve|server|start|preview|watch)\b" \
  -e "${EXPFX}(next|vite|nuxt|astro|remix|expo|turbo|nx|parcel|webpack-dev-server|ng|rails|air)[[:space:]]+(dev|serve|server|start|preview|watch)\b" \
  -e "${EXPFX}(make|just)[[:space:]]+(dev|serve|server|start|watch)\b" \
  -e "${EXPFX}cargo[[:space:]]+watch\b" \
  -e '\bmanage\.py[[:space:]]+runserver\b'; then
  exit 0
fi

# Verbose: package managers / builds / test runners — sh_run condenses these massively.
# Modern tools (bun/deno/uv) and image builds (docker build / compose build) are just as
# verbose as npm/pip. Note `docker ps|logs|run` and `docker compose up` are NOT matched here
# — they are read-only or long-running and fall through to the allow path / raw Bash.
# Tool names are anchored to EXECUTABLE POSITION via EXPFX (defined above the ALLOW class).
# ONE NAG PER SESSION: after the first block the model has been told; further verbose
# commands in the same session are allowed (the CLAUDE.md soft preference still applies).
# The marker is shared with the whole-diff class below — one nag total, not one per class.
MARK="${TMPDIR:-/tmp}/veil-guard-verbose-$SID"
VERBOSE_MSG='veil: verbose command (one nag per session) — retry EXACTLY as sh_run {"command":"<this same command string>","expect":{"exit":0}}. The only required key is "command" (a string; NOT cmd). Full output later via sh_detail. Prefix VEIL_BYPASS=1 to force Bash.'
NAG=""
if printf '%s' "$CMD" | grep -Eq \
  -e "${EXPFX}(npm|pnpm|yarn|bun|deno|uv|pip|pip3|cargo|go|gradle|mvn|bundle|composer|gem)\b[^|;&]*\b(install|i|ci|add|build|test|run|sync)\b" \
  -e "${EXPFX}(make|tsc|webpack|vite|rollup|esbuild|pytest|jest|vitest|mocha)\b" \
  -e "${EXPFX}docker(-compose|[[:space:]]+compose)?[[:space:]]+(build|buildx)\b"; then
  NAG="$VERBOSE_MSG"
fi

# WHOLE-DIFF DUMPS — the largest UNCOVERED source of context bloat. A 30-day audit of
# real Claude Code sessions found 133 raw-Bash results over 20k chars (3.2M chars total)
# and the top offenders were all `git diff dev..branch | cat`, `git diff --cached`,
# `git show <sha>` — none of which the package-manager patterns above match. Unlike a
# build log the agent usually wants ONE hunk, which is exactly sh_detail match=.
#
# Deliberately NOT matched (already small, or already bounded by the caller):
#   summary flags  — --stat/--numstat/--shortstat/--name-only/--name-status/--quiet/
#                    --exit-code/--compact-summary
#   bounding pipes — | head / tail / wc / grep / rg / sed / awk / cut / sort / uniq
#   plumbing       — the subcommand is anchored with ([[:space:]]|$), NOT \b, because `\b`
#                    matches before a hyphen: `git show-ref`, `git diff-tree`,
#                    `git diff-index` are small-output plumbing and must not nag.
# `| cat` is NOT bounding (it was the single most common dump idiom) and still nags.
if [ -z "$NAG" ] &&
   printf '%s' "$CMD" | grep -Eq "${EXPFX}git([[:space:]]+-C[[:space:]]+[^|;&[:space:]]+)?[[:space:]]+(diff|show)([[:space:]]|$)|${EXPFX}git[^|;&]*[[:space:]]+log[^|;&]*[[:space:]](-p|--patch)([[:space:]]|$)" &&
   ! printf '%s' "$CMD" | grep -Eq -e '--(stat|numstat|shortstat|name-only|name-status|quiet|exit-code|compact-summary)\b' \
     -e '\|[[:space:]]*(head|tail|wc|grep|rg|sed|awk|cut|sort|uniq)\b'; then
  NAG='veil: whole-diff dump — retry EXACTLY as sh_run {"command":"<this same command string>"}, then pull just the hunk you need with sh_detail {"id":"<id>","selector":"stdout","match":"<regex>"}. A full diff is usually thousands of tokens of which you read ten lines. Use --stat/--name-only if you only need the file list. Prefix VEIL_BYPASS=1 to force Bash.'
fi

if [ -n "$NAG" ]; then
  [ -e "$MARK" ] && exit 0           # already nagged this session — respect the model's choice
  : > "$MARK" 2>/dev/null || true    # marker write failure = still nag (fail toward nudge, never toward block-loop)
  echo "$NAG" >&2
  exit 2
fi

exit 0
