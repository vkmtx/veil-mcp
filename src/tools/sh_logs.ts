/** Tool: sh_logs — poll the output of a background run (sh_run background:true) by id. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLogs } from "../bgregistry.js";
import { get } from "../store.js";
import { condense } from "../render.js";

export function registerShLogs(server: McpServer): void {
  server.registerTool(
    "sh_logs",
    {
      title: "Poll a background run's output",
      description:
        "Read the output of a background run started with sh_run background:true, by id. " +
        "Returns a QUIET, condensed view of stdout/stderr plus status (running/exited/killed), " +
        "exit code, and running_ms. Pass back stdout_cursor/stderr_cursor (the values returned by " +
        "the previous call) to get ONLY new output since last poll — ideal for tailing a dev server. " +
        "A live process reads from its in-memory buffer; once it exits the SAME id resolves to the " +
        "durable record.",
      inputSchema: {
        id: z.string().describe("The background run id returned by sh_run (e.g. cmd7)."),
        stdout_cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("stdout byte cursor from a previous sh_logs call; returns only stdout since then."),
        stderr_cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("stderr byte cursor from a previous sh_logs call; returns only stderr since then."),
        stream: z
          .enum(["stdout", "stderr", "both"])
          .default("both")
          .describe("Which stream(s) to return."),
        full: z.boolean().optional().describe("If true, return full output inline (skip condensing)."),
      },
    },
    async ({ id, stdout_cursor, stderr_cursor, stream, full }) => {
      // Live path first: an in-flight (or just-exited-still-live) handle serves an
      // incremental slice since each stream's cursor, with the new cursors + gap flag.
      const live = getLogs(id, stdout_cursor, stderr_cursor, stream);
      if (live) {
        const result: Record<string, unknown> = {
          id,
          status: live.status,
          stdout_cursor: live.stdout_cursor,
          stderr_cursor: live.stderr_cursor,
          running_ms: Math.round(live.running_ms),
        };
        if (live.exit !== undefined) result.exit = live.exit;
        if (live.signal) result.signal = live.signal;
        if (live.gap) result.gap = true; // some bytes dropped at the byte cap between polls
        if (live.stdout_lines) result.stdout_lines = live.stdout_lines;
        if (live.stderr_lines) result.stderr_lines = live.stderr_lines;
        if (live.stdout_truncated) result.stdout_truncated = true;
        if (live.stderr_truncated) result.stderr_truncated = true;
        if (live.stdout !== undefined && live.stdout !== "") {
          result.stdout = full ? live.stdout : condense(live.stdout, id, "stdout", { truncated: live.stdout_truncated });
        }
        if (live.stderr !== undefined && live.stderr !== "") {
          result.stderr = full ? live.stderr : condense(live.stderr, id, "stderr", { truncated: live.stderr_truncated });
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      // Not live → the durable record (background run already exited and was flushed).
      const rec = get(id);
      if (!rec) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `unknown id: ${id}` }) }],
          isError: true,
        };
      }
      const result: Record<string, unknown> = {
        id,
        status: rec.killed ? "killed" : "exited",
        exit: rec.exit,
        running_ms: Math.round(rec.durationMs),
        // The record is the FULL final stream; each cursor is that stream's byte length
        // so a follow-up poll (against the record) returns nothing new.
        stdout_cursor: Buffer.byteLength(rec.stdout, rec.stdoutBinary ? "base64" : "utf8"),
        stderr_cursor: Buffer.byteLength(rec.stderr, rec.stderrBinary ? "base64" : "utf8"),
      };
      if (rec.signal) result.signal = rec.signal;
      if (rec.stdoutTruncated) result.stdout_truncated = true;
      if (rec.stderrTruncated) result.stderr_truncated = true;
      const wantOut = stream === "stdout" || stream === "both";
      const wantErr = stream === "stderr" || stream === "both";
      if (wantOut && rec.stdout && !rec.stdoutBinary) {
        result.stdout = full ? rec.stdout : condense(rec.stdout, id, "stdout", { truncated: rec.stdoutTruncated });
      }
      if (wantErr && rec.stderr && !rec.stderrBinary) {
        result.stderr = full ? rec.stderr : condense(rec.stderr, id, "stderr", { truncated: rec.stderrTruncated });
      }
      if (wantOut && rec.stdoutBinary) result.stdout_binary = true;
      if (wantErr && rec.stderrBinary) result.stderr_binary = true;
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
