/**
 * Comprehensive benchmark — what veil costs and what it saves, in detail.
 *
 * Five dimensions:
 *   1. Token economy   — bytes an agent ingests via sh_run vs a raw shell dump.
 *   2. Latency         — wall-clock overhead of sh_run vs raw execSync.
 *   3. Per-feature cost — ms each option (effect-diff, expect, sandbox, trace) adds.
 *   4. Condense detail  — how much a large output is compressed, recovery cost.
 *   5. Session model    — weighted net economy + projected tokens saved per session.
 *
 * Output bytes ≈ tokens (~4 B/token). Honest by design: tiny outputs LOSE to JSON
 * overhead; verbose outputs WIN big. Run: `tsx bench/bench.ts` (or via sh_run).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);
const rule = (n = 72) => console.log("─".repeat(n));
const tok = (b: number) => Math.round(b / 4);

function rawBytes(command: string, cwd?: string): number {
  try {
    return Buffer.byteLength(execSync(command, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] }), "utf8");
  } catch (e: any) {
    return (e.stdout ? Buffer.byteLength(e.stdout, "utf8") : 0) + (e.stderr ? Buffer.byteLength(e.stderr, "utf8") : 0);
  }
}

/** median of N timed async runs (ms); min-biased N keeps noise down. */
async function medMs(fn: () => Promise<unknown>, n = 5): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    await fn();
    xs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(n / 2)];
}
function medMsSync(fn: () => void, n = 5): number {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    fn();
    xs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(n / 2)];
}

const serverEntry = new URL("../src/index.ts", import.meta.url).pathname;
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry] });
const client = new Client({ name: "bench", version: "0.0.0" });
await client.connect(transport);

const run = async (args: Record<string, unknown>) =>
  (await client.callTool({ name: "sh_run", arguments: args })).content as any;
const bytesOf = (content: any) => Buffer.byteLength(content[0].text, "utf8");

// ── 1. TOKEN ECONOMY ────────────────────────────────────────────────────────
console.log("\n=== 1. TOKEN ECONOMY (bytes an agent ingests; ~4 B/token) ===");
interface Case { label: string; command: string; weight: number }
const CASES: Case[] = [
  { label: "echo (tiny)", command: "echo done", weight: 8 },
  { label: "git status (small)", command: "git status --porcelain || true", weight: 6 },
  { label: "ls -la (small)", command: "ls -la", weight: 6 },
  { label: "seq 200 (medium)", command: "seq 1 200", weight: 3 },
  { label: "seq 3000 (large)", command: "seq 1 3000", weight: 2 },
  { label: "build ~600 lines", command: "seq 1 600 | sed 's/^/[build] step /'", weight: 4 },
  { label: "install ~2000 lines", command: "seq 1 2000 | sed 's/^/npm http fetch /'", weight: 3 },
  { label: "failure (bad path)", command: "ls /no/such/path", weight: 2 },
];
console.log(pad("case", 24) + padL("raw B", 9) + padL("tok", 7) + padL("struct B", 10) + padL("tok", 7) + padL("save%", 8));
rule();
const econ: { weight: number; raw: number; structured: number }[] = [];
for (const c of CASES) {
  const raw = rawBytes(c.command);
  const structured = bytesOf(await run({ command: c.command }));
  const save = raw === 0 ? 0 : ((raw - structured) / raw) * 100;
  econ.push({ weight: c.weight, raw, structured });
  console.log(pad(c.label, 24) + padL(raw, 9) + padL(tok(raw), 7) + padL(structured, 10) + padL(tok(structured), 7) + padL(save.toFixed(0) + "%", 8));
}

// ── 2. LATENCY OVERHEAD ───────────────────────────────────────────────────────
console.log("\n=== 2. LATENCY (median of 5; sh_run incl. MCP round-trip + effects) ===");
console.log(pad("command", 24) + padL("raw ms", 10) + padL("sh_run ms", 12) + padL("overhead", 10));
rule();
for (const c of [
  { label: "echo done", command: "echo done" },
  { label: "ls -la", command: "ls -la" },
  { label: "seq 1 3000", command: "seq 1 3000" },
]) {
  const rawMs = medMsSync(() => { try { execSync(c.command, { stdio: ["ignore", "pipe", "pipe"] }); } catch { /* */ } });
  const shMs = await medMs(() => run({ command: c.command }));
  console.log(pad(c.label, 24) + padL(rawMs.toFixed(1), 10) + padL(shMs.toFixed(1), 12) + padL("+" + (shMs - rawMs).toFixed(1) + "ms", 10));
}

// ── 3. PER-FEATURE COST ───────────────────────────────────────────────────────
console.log("\n=== 3. PER-FEATURE COST (median ms of `echo hi`, same cwd) ===");
const fcwd = process.cwd(); // a git repo → effect-diff is live
const features: { label: string; args: Record<string, unknown> }[] = [
  { label: "read-only (ls, diff skipped)", args: { command: "ls", cwd: fcwd } },
  { label: "baseline mutating (true, diff on)", args: { command: "true", cwd: fcwd } },
  { label: "+ expect {exit:0}", args: { command: "true", cwd: fcwd, expect: { exit: 0 } } },
  { label: "+ trace:true", args: { command: "true", cwd: fcwd, trace: true } },
  { label: "+ sandbox:true", args: { command: "true", cwd: fcwd, sandbox: true } },
];
console.log(pad("variant", 36) + padL("median ms", 12));
rule();
for (const f of features) {
  const ms = await medMs(() => run(f.args));
  console.log(pad(f.label, 36) + padL(ms.toFixed(1), 12));
}

// ── 4. CONDENSE DETAIL ────────────────────────────────────────────────────────
console.log("\n=== 4. CONDENSE (large output: shown inline vs stored, recovery) ===");
{
  const N = 5000;
  const raw = rawBytes(`seq 1 ${N}`);
  const r = await run({ command: `seq 1 ${N}` });
  const inlineB = bytesOf(r);
  const id = JSON.parse((r as any)[0].text).id;
  const detailMs = await medMs(() => client.callTool({ name: "sh_detail", arguments: { id, selector: "stdout" } }), 3);
  console.log(`seq 1 ${N}: raw ${raw}B (${tok(raw)} tok) → inline ${inlineB}B (${tok(inlineB)} tok) = ${((1 - inlineB / raw) * 100).toFixed(1)}% hidden`);
  console.log(`full detail recoverable on demand via sh_detail (median ${detailMs.toFixed(1)}ms), pulled only when needed`);
}

// ── 5. SESSION MODEL ──────────────────────────────────────────────────────────
console.log("\n=== 5. SESSION MODEL (weighted mix → projected savings) ===");
const wRaw = econ.reduce((a, r) => a + r.raw * r.weight, 0);
const wStruct = econ.reduce((a, r) => a + r.structured * r.weight, 0);
const net = ((wRaw - wStruct) / wRaw) * 100;
const units = econ.reduce((a, r) => a + r.weight, 0);
console.log(`weighted net: ${net.toFixed(1)}% fewer bytes (raw ${wRaw}B → ${wStruct}B per ${units} weighted cmds)`);
console.log(`≈ ${tok(wRaw - wStruct)} tokens saved per ${units}-command unit; ~${tok((wRaw - wStruct) * (100 / units))} per 100 commands`);

await client.close();
console.log("\nNote: stored detail (sh_detail) is pulled rarely, so its bytes aren't");
console.log("counted in the economy rows — that is the lazy-detail thesis.");
