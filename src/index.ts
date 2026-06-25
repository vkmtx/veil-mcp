#!/usr/bin/env node
/**
 * veil-mcp — agent-native shell MCP server.
 *
 * Design line: quiet-by-default · addressable · lazy-detail · structured-replaces-text.
 * An LLM agent executes commands and gets EFFECTS AS DATA instead of a raw text dump
 * it must regex. Detail is stored and pulled on demand, never re-emitted into context.
 *
 * Modules: config · types · exec (timeout+cap) · effects (H) · render (I) · store (J)
 * · tools/{sh_run,sh_detail}. See ARCHITECTURE.md for the feature→module map.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, VERSION } from "./server.js";
import { runInit } from "./init.js";

const USAGE = `veil-mcp — agent-native shell MCP server.

Usage:
  veil-mcp            run as an MCP server over stdio (default)
  veil-mcp init       set up veil for the current project
  veil-mcp --version  print version and exit
  veil-mcp --help     print this help and exit

With no arguments it speaks the MCP protocol on stdin/stdout.`;

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  // CLI flags are handled before the stdio server starts so they print to stdout.
  console.log(VERSION);
} else if (arg === "--help" || arg === "-h") {
  console.log(USAGE);
} else if (arg === "init") {
  // `veil-mcp init` — one-off project setup, not the server. Handle and exit.
  runInit();
} else {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; logs must go to stderr.
  console.error("veil-mcp running on stdio");
}
