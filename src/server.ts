/** Builds the MCP server and wires every tool. */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerShRun } from "./tools/sh_run.js";
import { registerShDetail } from "./tools/sh_detail.js";
import { registerSnapshotTools } from "./tools/sh_snapshot.js";
import { registerShLogs } from "./tools/sh_logs.js";
import { registerShKill } from "./tools/sh_kill.js";

// Single source of truth: read the version from package.json at runtime so the
// version advertised over the MCP handshake can never drift from the published
// package. createRequire (not a static JSON import) keeps package.json outside
// tsconfig rootDir; `../package.json` resolves the same from src/ (tsx) and dist/.
const require = createRequire(import.meta.url);
export const VERSION: string = (require("../package.json") as { version: string }).version;

/**
 * Every tool is a slot in the agent's context on every request, so the surface is kept
 * to what actually gets called. sh_plan (static blast-radius preview) and sh_history
 * (descriptive run aggregates) were removed in 0.8.0 after a 30-day audit of real
 * Claude Code session logs measured ZERO calls to either across 3.5k sessions, while
 * sh_run took 3.5k. The classifier sh_plan exposed is unchanged and still gates sh_run —
 * only the standalone tool is gone; its taxonomy is asserted directly in test/smoke.ts.
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "veil-mcp", version: VERSION });
  registerShRun(server); // exec + rendering + addressable store + effects + assertions + read-confine + preview
  registerShDetail(server); // addressable output store
  registerSnapshotTools(server); // checkpoint / rollback
  registerShLogs(server); // poll a background run's output by id
  registerShKill(server); // stop a background run by id
  return server;
}
