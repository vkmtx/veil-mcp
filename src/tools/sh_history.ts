/**
 * Tool: sh_history — DESCRIPTIVE aggregates over past runs (feature: predictive
 * history, honest slice). It restates what the local store already recorded:
 * observed exit/retry/duration/file-churn for a command, with explicit sample size
 * and recency window. It makes NO causal claim ("X produced Y") and NO prediction
 * ("80% likely") — the store is a local, capped, TTL-pruned window, so every number
 * is labelled with its n. Read-only; never executes anything.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { all } from "../store.js";
import type { RunRecord } from "../types.js";

/** Collapse whitespace so `npm  test` and `npm test` group together. */
function normalize(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/** Nearest-rank percentile (p in [0,1]) of a numeric list; 0 for an empty list. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function summarize(command: string, recs: RunRecord[]): Record<string, unknown> {
  const exit0 = recs.filter((r) => r.exit === 0).length;
  const timedOut = recs.filter((r) => r.timedOut).length;
  const retried = recs.filter((r) => r.attempts > 1);
  const durations = recs.map((r) => Math.round(r.durationMs));
  const churn = recs.filter((r) => Array.isArray(r.filesChanged)).map((r) => (r.filesChanged as string[]).length);
  const times = recs.map((r) => r.at).filter((t) => typeof t === "number" && t > 0);
  const first = times.length ? Math.min(...times) : 0;
  const last = times.length ? Math.max(...times) : 0;

  const out: Record<string, unknown> = {
    command,
    n: recs.length,
    exit0,
    nonzero: recs.length - exit0,
    duration_ms: { p50: percentile(durations, 0.5), p90: percentile(durations, 0.9) },
  };
  if (timedOut) out.timed_out = timedOut;
  if (retried.length) {
    const recovered = retried.filter((r) => r.exit === 0).length;
    out.retried = `recovered ${recovered}/${retried.length}`;
  }
  if (churn.length) out.files_changed_median = median(churn);
  if (first && last) {
    out.window = {
      first: new Date(first).toISOString(),
      last: new Date(last).toISOString(),
      span_h: Math.round(((last - first) / 3_600_000) * 10) / 10,
    };
  }
  return out;
}

export function registerShHistory(server: McpServer): void {
  server.registerTool(
    "sh_history",
    {
      title: "Observed history for past runs (descriptive)",
      description:
        "Aggregate PAST sh_run records for a command: observed exit/retry/duration/" +
        "file-churn with explicit sample size (n) and recency window. DESCRIPTIVE only " +
        "— it restates this local, capped, TTL-pruned store; it is NOT a prediction and " +
        "makes NO causal claim. Read-only, runs nothing. Use to judge whether a command " +
        "is historically slow/flaky in THIS project before running it.",
      inputSchema: {
        command: z
          .string()
          .optional()
          .describe("Exact command to summarize (whitespace-normalized). Omit to list the busiest commands."),
        like: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter on the command (ignored if `command` is given)."),
        limit: z.number().int().positive().optional().describe("Max command groups to return (default 10)."),
      },
    },
    async ({ command, like, limit }) => {
      const records = all();
      const max = limit ?? 10;

      // Group by normalized command, applying the requested filter.
      const groups = new Map<string, RunRecord[]>();
      const wantExact = command !== undefined ? normalize(command) : undefined;
      const likeLc = like?.toLowerCase();
      for (const r of records) {
        const key = normalize(r.command);
        if (wantExact !== undefined) {
          if (key !== wantExact) continue;
        } else if (likeLc !== undefined && !key.toLowerCase().includes(likeLc)) {
          continue;
        }
        const bucket = groups.get(key);
        if (bucket) bucket.push(r);
        else groups.set(key, [r]);
      }

      const matched = Array.from(groups.values()).reduce((s, g) => s + g.length, 0);
      const summaries = Array.from(groups.entries())
        .map(([cmd, recs]) => summarize(cmd, recs))
        .sort((a, b) => (b.n as number) - (a.n as number))
        .slice(0, max);

      const payload = {
        store: `local store: ${records.length} run(s) total (capped by VEIL_MAX_RECORDS, TTL-pruned)`,
        matched,
        groups: summaries,
        note:
          "Observed counts from THIS local store only — descriptive, not predictive, no causation implied. " +
          "Small or stale n is unreliable; a single command string may span different code states.",
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  );
}
