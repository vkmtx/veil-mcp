/** Builds the MCP server and wires every tool. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerShRun } from "./tools/sh_run.js";
import { registerShDetail } from "./tools/sh_detail.js";
import { registerShPlan } from "./tools/sh_plan.js";
import { registerSnapshotTools } from "./tools/sh_snapshot.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "veil-mcp", version: "0.3.0" });
  registerShRun(server); // exec + I/J/H/G/M
  registerShDetail(server); // J
  registerShPlan(server); // B + K-lite
  registerSnapshotTools(server); // C
  return server;
}
