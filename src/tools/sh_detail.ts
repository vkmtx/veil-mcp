/** Tool: sh_detail — pull stored output for a previous run by id, without re-running. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { get } from "../store.js";

export function registerShDetail(server: McpServer): void {
  server.registerTool(
    "sh_detail",
    {
      title: "Pull stored detail for a previous run",
      description:
        "Retrieve full stored output for a previous sh_run by id WITHOUT re-running it " +
        "(feature J — addressable output). Use after a condensed result hid lines you need.",
      inputSchema: {
        id: z.string().describe("The run id returned by sh_run (e.g. cmd3)."),
        selector: z
          .enum(["stdout", "stderr", "full", "meta", "trace"])
          .default("full")
          .describe("Which slice to return. 'trace' returns the full captured syscall trace (feature A)."),
        match: z
          .string()
          .optional()
          .describe(
            "With selector stdout/stderr: return ONLY lines matching this regex (with line numbers) — " +
              "grep the stored stream for a value condensing hid, without dumping it all.",
          ),
      },
    },
    async ({ id, selector, match }) => {
      const rec = get(id);
      if (!rec) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `unknown id: ${id}` }) }],
          isError: true,
        };
      }
      // Addressable SEARCH: filter the stored stream by regex instead of returning it
      // whole. Mitigates condense hiding a non-error value in the middle — pull just
      // the matching lines, no re-run, no full dump.
      if (match !== undefined && (selector === "stdout" || selector === "stderr")) {
        const isBinary = selector === "stdout" ? rec.stdoutBinary : rec.stderrBinary;
        if (isBinary) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "match not supported on a binary stream" }) }], isError: true };
        }
        let re: RegExp;
        try {
          re = new RegExp(match);
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `invalid regex: ${String(e instanceof Error ? e.message : e)}` }) }], isError: true };
        }
        const truncated = selector === "stdout" ? rec.stdoutTruncated : rec.stderrTruncated;
        const lines = (selector === "stdout" ? rec.stdout : rec.stderr).split("\n");
        const hits: string[] = [];
        for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(`L${i + 1}: ${lines[i]}`);
        const cap = 200;
        const header =
          `${hits.length} line(s) in ${selector} matching /${match}/` +
          (truncated ? " (retained tail only)" : "") +
          (hits.length > cap ? `, showing first ${cap}` : "") +
          ":";
        return { content: [{ type: "text", text: [header, ...hits.slice(0, cap)].join("\n") }] };
      }
      // When a stream was byte-capped, its stored payload is the retained TAIL —
      // tell the caller so they don't read it as the complete stream.
      // Binary streams are stored base64 for a lossless round-trip; a human banner
      // would corrupt the decode, so only banner TEXT streams. The truncated+binary
      // fact is still available via the meta selector.
      const TAIL_BANNER = "[truncated: earliest output dropped at byte cap; this is the retained tail only]\n";
      let payload: unknown;
      switch (selector) {
        case "stdout":
          payload = rec.stdoutTruncated && !rec.stdoutBinary ? TAIL_BANNER + rec.stdout : rec.stdout;
          break;
        case "stderr":
          payload = rec.stderrTruncated && !rec.stderrBinary ? TAIL_BANNER + rec.stderr : rec.stderr;
          break;
        case "trace":
          payload = rec.trace ?? "(no trace captured for this run)";
          break;
        case "meta":
          payload = {
            id: rec.id,
            command: rec.command,
            cwd: rec.cwd,
            exit: rec.exit,
            duration_ms: Math.round(rec.durationMs),
            timed_out: rec.timedOut,
            attempts: rec.attempts,
            stdout_truncated: rec.stdoutTruncated,
            stderr_truncated: rec.stderrTruncated,
            stdout_binary: rec.stdoutBinary,
            stderr_binary: rec.stderrBinary,
            traced: rec.trace !== undefined,
            files_changed: rec.filesChanged ?? "n/a (not a git repo)",
          };
          break;
        default:
          payload = rec;
      }
      const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
      return { content: [{ type: "text", text }] };
    },
  );
}
