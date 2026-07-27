/** Tool: sh_kill — stop a background run (sh_run background:true) by id. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kill } from "../bgregistry.js";
import { get } from "../store.js";
import { defaultBackgroundId, noRunError, unknownIdError } from "../runid.js";

const NO_RUN_HINT = "nothing was started with sh_run background:true in this session";

export function registerShKill(server: McpServer): void {
  server.registerTool(
    "sh_kill",
    {
      title: "Stop a background run",
      description:
        "Stop a background run started with sh_run background:true, by id. Signals the whole " +
        "process group (so a dev server's children die too). SIGTERM (the default) escalates to " +
        "SIGKILL after 2s if the process ignores it. Returns status:\"terminating\" — the signal " +
        "was sent but the OS hasn't confirmed the process is dead yet; poll sh_logs to see it " +
        "settle to exited/killed. Killing an id whose process has ALREADY exited is not an error " +
        "— it returns already_exited (idempotent).",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe("The background run id returned by sh_run (e.g. cmd7). Omit to stop the most recently started live run."),
        signal: z
          .enum(["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP", "SIGQUIT"])
          .default("SIGTERM")
          .describe("Signal to send. SIGTERM escalates to SIGKILL after 2s."),
      },
    },
    async ({ id: requestedId, signal }) => {
      // No id → the newest live background run. Killing "the dev server I just started"
      // is the overwhelmingly common call and shouldn't require threading its id through.
      const id = requestedId ?? defaultBackgroundId();
      if (!id) {
        return { content: [{ type: "text", text: JSON.stringify({ error: noRunError(NO_RUN_HINT) }) }], isError: true };
      }
      const res = kill(id, signal);
      if (res.status === "terminating") {
        // The signal was sent; the process is being torn down but not confirmed dead yet.
        return {
          content: [{ type: "text", text: JSON.stringify({ id, status: "terminating", signal, ok: true }) }],
        };
      }
      // Not live. If a record exists, the process already exited — idempotent success,
      // NOT an error. Otherwise the id is unknown.
      if (get(id)) {
        return { content: [{ type: "text", text: JSON.stringify({ id, status: "already_exited" }) }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ error: unknownIdError(id, NO_RUN_HINT) }) }],
        isError: true,
      };
    },
  );
}
