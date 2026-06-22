/**
 * `veil-mcp init` — zero-friction per-project setup.
 *
 * Adoption hinges on the agent actually preferring sh_run over raw Bash, which it
 * only does when the project tells it to. This drops that nudge into the project's
 * CLAUDE.md (idempotent, via a marked block) and prints the one-line MCP-registration
 * command plus the optional guard-hook pointer. It touches ONLY CLAUDE.md in the
 * target dir — never global agent settings.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARK_START = "<!-- veil-mcp:start -->";
const MARK_END = "<!-- veil-mcp:end -->";

const NUDGE = `${MARK_START}
## veil-mcp

When the \`veil\` MCP server is connected, prefer its tools over raw Bash:

- **\`sh_run\`** instead of raw Bash for any command that changes files (build,
  install, codegen, \`mv\`/\`rm\`/\`cp\`, formatters) or is likely verbose. It returns a
  quiet structured result and stores full output addressably.
  - Add **\`expect\`** to verify in the same call (e.g. \`{ exit: 0, file_exists: "dist/index.js" }\`).
  - Add **\`sandbox: true\`** to confine a risky command (opt-in; macOS solid, Linux experimental).
- **\`sh_detail id=<id>\`** to recover output a condensed result hid — never re-run a command to see it again.
- **\`sh_plan\`** for a static safety pre-check before a destructive command.
- **\`sh_checkpoint\`** / **\`sh_restore\`** to snapshot and roll back a risky change.

Use raw Bash only for trivial read-only or interactive/TTY commands.
${MARK_END}`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Write (or idempotently update) the veil-mcp nudge block in `<cwd>/CLAUDE.md` and
 * print the remaining setup steps. Returns the action taken (for tests).
 */
export function runInit(cwd: string = process.cwd()): string {
  const path = join(cwd, "CLAUDE.md");
  let action: string;
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    // Markers are matched ONLY when alone on their own line (^…$, `m` flag), so a
    // marker quoted in prose can't be mistaken for the real thing. Count them: an
    // in-place replace is safe ONLY when there is exactly one well-formed block —
    // one start, one end, start before end. A lazy ^start$…^end$ span would, given
    // an orphaned start marker sitting before a later complete block, stretch across
    // the user content between them and delete it on replace. Any ambiguous topology
    // (orphaned / duplicated / interleaved markers) therefore APPENDS a fresh block
    // and never removes anything outside a single clean block.
    const starts = [...cur.matchAll(new RegExp(`^${escapeRe(MARK_START)}$`, "mg"))];
    const ends = [...cur.matchAll(new RegExp(`^${escapeRe(MARK_END)}$`, "mg"))];
    const from = starts[0]?.index ?? -1;
    const to = ends[0] ? ends[0].index + ends[0][0].length : -1;
    if (starts.length === 1 && ends.length === 1 && from < to) {
      writeFileSync(path, cur.slice(0, from) + NUDGE + cur.slice(to));
      action = "updated veil-mcp block in";
    } else if (starts.length === 0 && ends.length === 0) {
      writeFileSync(path, `${cur.trimEnd()}\n\n${NUDGE}\n`);
      action = "appended veil-mcp nudge to";
    } else {
      // Stale/duplicated/interleaved markers — append a clean block, touch nothing else.
      writeFileSync(path, `${cur.trimEnd()}\n\n${NUDGE}\n`);
      action = "appended veil-mcp nudge (left existing markers intact) in";
    }
  } else {
    writeFileSync(path, `${NUDGE}\n`);
    action = "created";
  }
  // CLI invocation, not the MCP stdio channel → ordinary stdout is fine.
  process.stdout.write(
    `veil-mcp: ${action} ${path}\n\n` +
      `Next steps:\n` +
      `  1. Register the server with your agent:\n` +
      `       claude mcp add veil -- npx -y github:vkmtx/veil-mcp\n` +
      `     (other agents — MCP config: command "npx", args ["-y","github:vkmtx/veil-mcp"])\n` +
      `  2. (optional) Enforce the nudge with the PreToolUse guard hook —\n` +
      `       see hooks/veil-guard.sh in the veil-mcp repo.\n`,
  );
  return action;
}
