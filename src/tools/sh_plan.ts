/**
 * Tool: sh_plan — predict a command's blast radius and file effects WITHOUT
 * executing it (dry-run plan + static classification).
 *
 * Use before a risky command to decide whether to run it, checkpoint first, or
 * ask the user. Best-effort static analysis — see classify.ts for limits.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { classify } from "../classify.js";

export function registerShPlan(server: McpServer): void {
  server.registerTool(
    "sh_plan",
    {
      title: "Plan / dry-run a command (no execution)",
      description:
        "Statically predict what a command WOULD do without running it: blast-radius " +
        "category (read-only | mutating | destructive | network | complex | unknown), " +
        "whether it's reversible, and predicted file mutations. Use before destructive " +
        "or unfamiliar commands. Does NOT execute anything.",
      inputSchema: {
        command: z.string().describe("The command to analyze."),
      },
    },
    async ({ command }) => {
      const c = classify(command);
      const result: Record<string, unknown> = {
        command,
        category: c.category,
        reversible: c.reversible,
      };
      if (c.mutations.length) result.mutations = c.mutations;
      if (c.note) result.note = c.note;
      if (c.category === "destructive") {
        result.warning = "DESTRUCTIVE — consider sh_checkpoint before running, or confirm with the user.";
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
