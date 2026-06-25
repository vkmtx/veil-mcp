/** Tool: sh_kill — stop a background run (sh_run background:true) by id. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kill } from "../bgregistry.js";
import { get } from "../store.js";

export function registerShKill(server: McpServer): void {
  server.registerTool(
    "sh_kill",
    {
      title: "Stop a background run",
      description:
        "Stop a background run started with sh_run background:true, by id. Signals the whole " +
        "process group (so a dev server's children die too). SIGTERM (the default) escalates to " +
        "SIGKILL after 2s if the process ignores it. Killing an id whose process has ALREADY " +
        "exited is not an error — it returns already_exited (idempotent).",
      inputSchema: {
        id: z.string().describe("The background run id returned by sh_run (e.g. cmd7)."),
        signal: z
          .enum(["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP", "SIGQUIT"])
          .default("SIGTERM")
          .describe("Signal to send. SIGTERM escalates to SIGKILL after 2s."),
      },
    },
    async ({ id, signal }) => {
      const res = kill(id, signal);
      if (res.status === "killed") {
        return {
          content: [{ type: "text", text: JSON.stringify({ id, status: "killed", signal, ok: true }) }],
        };
      }
      // Not live. If a record exists, the process already exited — idempotent success,
      // NOT an error. Otherwise the id is unknown.
      if (get(id)) {
        return { content: [{ type: "text", text: JSON.stringify({ id, status: "already_exited" }) }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `unknown id: ${id}` }) }],
        isError: true,
      };
    },
  );
}
