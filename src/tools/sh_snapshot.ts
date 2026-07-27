/**
 * Tools: sh_checkpoint / sh_restore / sh_checkpoints — working-tree rollback
 * safety net (checkpoint / rollback). Checkpoint before a risky change; restore to undo it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkpoint, restore, list, latest, autoLabel } from "../snapshot.js";

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

export function registerSnapshotTools(server: McpServer): void {
  server.registerTool(
    "sh_checkpoint",
    {
      title: "Checkpoint a directory (rollback point)",
      description:
        "Snapshot a working directory under a label so you can restore it later with " +
        "sh_restore. Excludes .git and node_modules. Take one before a risky or " +
        "irreversible change.",
      inputSchema: {
        // Optional on purpose: a required label made the one-call safety net a
        // two-decision call right before a risky command, and a missing label failed
        // the call outright. Omitted → the next unused auto-N.
        label: z
          .string()
          .optional()
          .describe("Checkpoint name ([A-Za-z0-9._-]). Omit for an auto-numbered label (auto-1, auto-2, …)."),
        dir: z.string().optional().describe("Directory to snapshot. Defaults to server cwd."),
      },
    },
    async ({ label, dir }) => {
      const target = dir ?? process.cwd();
      try {
        const info = checkpoint(label ?? autoLabel(target), target);
        return ok({ checkpointed: info.label, dir: info.dir, method: info.method });
      } catch (e) {
        return fail(String(e instanceof Error ? e.message : e));
      }
    },
  );

  server.registerTool(
    "sh_restore",
    {
      title: "Restore a directory from a checkpoint",
      description:
        "Mirror a directory back to a previous sh_checkpoint (files created since the " +
        "checkpoint are removed). This is the rollback for an agent's mistakes.",
      inputSchema: {
        label: z
          .string()
          .optional()
          .describe("Checkpoint name to restore. Omit to restore the most recent checkpoint for this dir."),
        dir: z.string().optional().describe("Directory to restore into. Defaults to server cwd."),
      },
    },
    async ({ label, dir }) => {
      const target = dir ?? process.cwd();
      // Resolve "no label" to the newest checkpoint, and answer an unknown label with
      // the labels that DO exist — a rollback tool that just says "not found" while the
      // tree is already broken is the least useful moment to be terse.
      const chosen = label ?? latest(target);
      if (!chosen) return fail(`no checkpoint exists for ${target} — take one with sh_checkpoint before the risky change`);
      const known = list(target);
      if (!known.includes(chosen)) {
        // Keep restore()'s established "no checkpoint named" wording (checkpoints are
        // namespaced per source dir, so a right label under the wrong dir lands here),
        // and add the labels that DO exist.
        return fail(
          `no checkpoint named "${chosen}" for ${target}` +
            (known.length ? `; existing: ${known.join(", ")}` : " — none exist for this dir; take one with sh_checkpoint first"),
        );
      }
      try {
        const info = restore(chosen, target);
        return ok({ restored: info.label, dir: info.dir });
      } catch (e) {
        return fail(String(e instanceof Error ? e.message : e));
      }
    },
  );

  server.registerTool(
    "sh_checkpoints",
    {
      title: "List checkpoints",
      description: "List existing checkpoint labels for a project directory (checkpoints are namespaced per directory).",
      inputSchema: {
        dir: z.string().optional().describe("Project directory whose checkpoints to list. Defaults to server cwd."),
      },
    },
    async ({ dir }) => ok({ checkpoints: list(dir ?? process.cwd()) }),
  );
}
