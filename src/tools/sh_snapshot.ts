/**
 * Tools: sh_checkpoint / sh_restore / sh_checkpoints — working-tree rollback
 * safety net (feature C). Checkpoint before a risky change; restore to undo it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkpoint, restore, list } from "../snapshot.js";

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
        label: z.string().describe("Checkpoint name ([A-Za-z0-9._-])."),
        dir: z.string().optional().describe("Directory to snapshot. Defaults to server cwd."),
      },
    },
    async ({ label, dir }) => {
      try {
        const info = checkpoint(label, dir ?? process.cwd());
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
        label: z.string().describe("Checkpoint name to restore."),
        dir: z.string().optional().describe("Directory to restore into. Defaults to server cwd."),
      },
    },
    async ({ label, dir }) => {
      try {
        const info = restore(label, dir ?? process.cwd());
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
      description: "List existing checkpoint labels.",
      inputSchema: {},
    },
    async () => ok({ checkpoints: list() }),
  );
}
