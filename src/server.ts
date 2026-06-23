/** Builds the MCP server and wires every tool. */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerShRun } from "./tools/sh_run.js";
import { registerShDetail } from "./tools/sh_detail.js";
import { registerShPlan } from "./tools/sh_plan.js";
import { registerSnapshotTools } from "./tools/sh_snapshot.js";
import { registerShHistory } from "./tools/sh_history.js";

// Single source of truth: read the version from package.json at runtime so the
// version advertised over the MCP handshake can never drift from the published
// package. createRequire (not a static JSON import) keeps package.json outside
// tsconfig rootDir; `../package.json` resolves the same from src/ (tsx) and dist/.
const require = createRequire(import.meta.url);
export const VERSION: string = (require("../package.json") as { version: string }).version;

export function buildServer(): McpServer {
  const server = new McpServer({ name: "veil-mcp", version: VERSION });
  registerShRun(server); // exec + I/J/H/G/M + read-confine + preview
  registerShDetail(server); // J
  registerShPlan(server); // B + K-lite
  registerSnapshotTools(server); // C
  registerShHistory(server); // descriptive run history
  return server;
}
