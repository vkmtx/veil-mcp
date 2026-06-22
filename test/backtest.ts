/**
 * Performance backtest — guards the core thesis against regressions.
 *
 * Re-runs the benchmark mix and asserts two falsifiable floors: the weighted bulk
 * byte savings (dominated by verbose output, where bulk savings live) AND a
 * per-SHORT-command envelope-overhead cap — so fixed-overhead JSON bloat that the
 * weighted net would hide still fails CI. Exits non-zero on regression.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the benchmark's runs out of the real on-disk store (child server inherits this).
process.env.VEIL_STATE_DIR = mkdtempSync(join(tmpdir(), "veil-backtest-state-"));

const FLOOR_NET_PCT = 70; // weighted net savings must stay above this
const FLOOR_VERBOSE_PCT = 85; // each verbose case must save at least this
// A SHORT command's structured envelope (id/exit/ms/condensed stdout/…) must not
// exceed its raw output by more than this many bytes. The byte-weighted net% below
// is — correctly — dominated by the verbose cases (that's where bulk savings live),
// so it cannot catch fixed-overhead bloat on short commands; this per-command floor
// does, directly. Current envelopes are ~70–140B (the failure case carries the OS
// stderr), so 300 trips a clear envelope regression while tolerating per-OS/ms drift.
const MAX_OVERHEAD_BYTES = 300;

interface Case { label: string; command: string; weight: number; verbose?: boolean }
const CASES: Case[] = [
  { label: "echo", command: "echo done", weight: 8 },
  { label: "git status", command: "git status --porcelain || true", weight: 6 },
  { label: "ls -la", command: "ls -la", weight: 6 },
  { label: "seq 80", command: "seq 1 80", weight: 3 },
  { label: "build ~600", command: "seq 1 600 | sed 's/^/[build] step /'", weight: 4, verbose: true },
  { label: "install ~2000", command: "seq 1 2000 | sed 's/^/npm http fetch /'", weight: 3, verbose: true },
  { label: "failure", command: "ls /no/such/path", weight: 2 },
];

function rawBytes(command: string): number {
  try {
    return Buffer.byteLength(execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), "utf8");
  } catch (e: any) {
    return (e.stdout ? Buffer.byteLength(e.stdout) : 0) + (e.stderr ? Buffer.byteLength(e.stderr) : 0);
  }
}

const serverEntry = new URL("../src/index.ts", import.meta.url).pathname;
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry] });
const client = new Client({ name: "backtest", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
let wRaw = 0, wStruct = 0;
for (const c of CASES) {
  const raw = rawBytes(c.command);
  const r = await client.callTool({ name: "sh_run", arguments: { command: c.command } });
  const structured = Buffer.byteLength((r.content as any)[0].text, "utf8");
  wRaw += raw * c.weight;
  wStruct += structured * c.weight;
  if (c.verbose) {
    const delta = ((raw - structured) / raw) * 100;
    const pass = delta >= FLOOR_VERBOSE_PCT;
    console.log(`${pass ? "✓" : "✗"} verbose "${c.label}" saves ${delta.toFixed(0)}% (floor ${FLOOR_VERBOSE_PCT}%)`);
    if (!pass) failures++;
  } else {
    // Short command: the envelope must not balloon. Catches per-command JSON bloat
    // the weighted net% would hide.
    const overhead = structured - raw;
    const pass = overhead <= MAX_OVERHEAD_BYTES;
    console.log(`${pass ? "✓" : "✗"} short "${c.label}" overhead ${overhead}B (cap ${MAX_OVERHEAD_BYTES}B)`);
    if (!pass) failures++;
  }
}
await client.close();

const net = ((wRaw - wStruct) / wRaw) * 100;
const netPass = net >= FLOOR_NET_PCT;
console.log(`${netPass ? "✓" : "✗"} weighted net ${net.toFixed(1)}% (floor ${FLOOR_NET_PCT}%)`);
if (!netPass) failures++;

console.log(failures === 0 ? "\nBACKTEST PASS" : `\nBACKTEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
