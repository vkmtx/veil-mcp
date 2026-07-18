/**
 * Value metrics — the numbers behind "why veil", measured (not asserted).
 *
 * Four dimensions that quantify the value the README claims qualitatively. Unlike
 * bench.ts (cost/economy) these target the *moat* — the things raw Bash + truncation
 * cannot do:
 *   1. Agent turns saved   — MCP round-trips collapsed into one call (the real bet).
 *   2. Sandbox escapes blocked — adversarial write/network attempts the kernel denies.
 *   3. Signal recall        — buried failures surfaced from a labeled log corpus.
 *   4. Checkpoint cost      — CoW clone latency + space vs the rsync mirror.
 *
 * Deterministic dimensions (1, 3) are also asserted in test/smoke.ts so they can't
 * rot. Run: `npm run metrics` (or via sh_run). macOS exercises the real sandbox/clone;
 * elsewhere those dimensions self-report unavailable rather than faking a number.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statfsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { condense } from "../src/render.js";
import { TURNS, recallCorpus, recallSurfaced } from "./metrics-data.js";

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);
const rule = (n = 72) => console.log("─".repeat(n));
const pct = (n: number, d: number) => (d === 0 ? 0 : (n / d) * 100);

process.env.VEIL_STATE_DIR = mkdtempSync(join(tmpdir(), "veil-metrics-state-"));

// ── 1. AGENT TURNS SAVED ──────────────────────────────────────────────────────
// The actual bet: structure + effects + expect collapse a multi-call run→check→grep
// loop into ONE MCP call. This is structural (counts calls, not bytes), so it holds
// regardless of context-window size — the survival argument over token economy.
console.log("\n=== 1. AGENT TURNS SAVED — scenario model (MCP round-trips per task) ===");
console.log(pad("task", 40) + padL("raw", 5) + padL("veil", 6) + padL("saved", 7));
rule();
let rawTotal = 0, veilTotal = 0;
for (const t of TURNS) {
  rawTotal += t.raw;
  veilTotal += t.veil;
  console.log(pad(t.task, 40) + padL(t.raw, 5) + padL(t.veil, 6) + padL(t.raw - t.veil, 7));
}
rule();
console.log(
  pad(`TOTAL across ${TURNS.length} common tasks`, 40) +
    padL(rawTotal, 5) + padL(veilTotal, 6) + padL(rawTotal - veilTotal, 7),
);
console.log(`→ ~${pct(rawTotal - veilTotal, rawTotal).toFixed(0)}% fewer round-trips on this task set (${rawTotal} → ${veilTotal} calls) — a scenario model over ${TURNS.length} hand-picked common tasks, not a live measurement`);

// ── 3. SIGNAL RECALL ──────────────────────────────────────────────────────────
// Honesty claim made falsifiable: a labeled corpus of logs, each with ONE known
// failure line buried in the elided middle (incl. non-keyword crash idioms). Recall =
// fraction the condenser surfaces. (Numbered 3 to match the module header; printed
// before the server-dependent dimensions so the deterministic parts run first.)
console.log("\n=== 3. SIGNAL RECALL (buried failures surfaced from a labeled corpus) ===");
const surfaced = recallCorpus.filter((c) => recallSurfaced(c, condense));
console.log(pad("fixture", 40) + padL("buried failure", 30) + padL("surfaced", 10));
rule(80);
for (const c of recallCorpus) {
  console.log(pad(c.name, 40) + padL(c.fail.slice(0, 28), 30) + padL(recallSurfaced(c, condense) ? "✓" : "✗ MISS", 10));
}
rule(80);
console.log(`→ recall ${surfaced.length}/${recallCorpus.length} = ${pct(surfaced.length, recallCorpus.length).toFixed(0)}% (each failure sits in the hidden middle, not head/tail)`);

// Spin up the server for the kernel-backed dimensions.
const serverEntry = new URL("../src/index.ts", import.meta.url).pathname;
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry] });
const client = new Client({ name: "metrics", version: "0.0.0" });
await client.connect(transport);

// ── 2. SANDBOX ESCAPES BLOCKED ────────────────────────────────────────────────
// The one capability a shell fork genuinely cannot provide. Adversarial corpus of
// writes/network that MUST be denied; a control write inside cwd MUST land.
console.log("\n=== 2. SANDBOX ESCAPES BLOCKED (kernel write/network confinement) ===");
{
  const probe = JSON.parse(((await client.callTool({ name: "sh_run", arguments: { command: "echo probe", sandbox: true } })).content as any)[0].text);
  if (probe.sandbox_unavailable) {
    console.log("→ sandbox unavailable on this platform — SKIPPED (refuses to run unconfined, by design)");
  } else {
    const work = mkdtempSync(join(tmpdir(), "veil-sbx-work-"));
    const outside = join(homedir(), `.veil-escape-${process.pid}.txt`); // outside cwd + temp
    const attempts: { name: string; command: string; target: string; net?: boolean }[] = [
      { name: "write to $HOME (outside cwd+temp)", command: `echo X > ${outside}`, target: outside },
      { name: "write via spawned child (perl)", command: `perl -e 'open(F,">","${outside}") or exit 0; print F "x"; close F'`, target: outside },
      { name: "write to /etc (system path)", command: `echo X > /etc/veil-escape-${process.pid}`, target: `/etc/veil-escape-${process.pid}` },
      { name: "write through a cwd symlink to $HOME", command: `ln -sf ${outside} link && echo X > link`, target: outside },
      { name: "network connect (network:false)", command: `curl -s -m 3 http://example.com >/dev/null && echo CONNECTED > ${outside}`, target: outside, net: true },
    ];
    let blocked = 0;
    console.log(pad("escape attempt", 44) + padL("result", 12));
    rule(60);
    for (const a of attempts) {
      try { rmSync(a.target, { force: true }); } catch { /* */ }
      await client.callTool({ name: "sh_run", arguments: { command: a.command, cwd: work, sandbox: a.net ? { network: false } : true } });
      const escaped = existsSync(a.target);
      if (!escaped) blocked++;
      console.log(pad(a.name, 44) + padL(escaped ? "✗ ESCAPED" : "✓ blocked", 12));
    }
    // control: a write INSIDE cwd must succeed (proves it's selective, not a deny-all).
    await client.callTool({ name: "sh_run", arguments: { command: "echo IN > inside.txt", cwd: work, sandbox: true } });
    const controlOk = existsSync(join(work, "inside.txt"));
    rule(60);
    console.log(`→ blocked ${blocked}/${attempts.length} escapes; control write inside cwd ${controlOk ? "landed ✓" : "FAILED ✗"} (selective, not deny-all)`);
    try { rmSync(work, { recursive: true, force: true }); rmSync(outside, { force: true }); } catch { /* */ }
  }
}

await client.close();

// ── 4. CHECKPOINT COST (CoW clone vs rsync mirror) ────────────────────────────
console.log("\n=== 4. CHECKPOINT COST (CoW clone latency + space vs rsync) ===");
{
  // A working tree with real bulk (build artifacts, fixtures, media): this is where
  // CoW's block-sharing wins — for a tree of tiny files, clonefile's per-file syscall
  // overhead can lose to a streamed copy, and the space saving is below noise.
  const src = mkdtempSync(join(tmpdir(), "veil-ckpt-src-"));
  const FILES = 6;
  const FILE_BYTES = 10 * 1024 * 1024; // 10 MB each
  for (let i = 0; i < FILES; i++) writeFileSync(join(src, `f${i}.bin`), "x".repeat(FILE_BYTES));
  const srcBytes = FILES * FILE_BYTES;

  const freeBefore = freeBytes(src);
  const t0 = process.hrtime.bigint();
  const info = await import("../src/snapshot.js").then((m) => m.checkpoint("metrics-bench", src));
  const cloneMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const freeAfter = freeBytes(src);
  const consumed = freeBefore != null && freeAfter != null ? freeBefore - freeAfter : null;

  // Time a plain rsync mirror of the same tree for comparison.
  const rdest = mkdtempSync(join(tmpdir(), "veil-ckpt-rsync-"));
  const r0 = process.hrtime.bigint();
  execFileSync("rsync", ["-a", "--delete", `${src}/`, `${rdest}/`], { stdio: "ignore" });
  const rsyncMs = Number(process.hrtime.bigint() - r0) / 1e6;

  const mb = (b: number) => (b / 1048576).toFixed(b < 1048576 ? 1 : 0);
  console.log(`source tree: ${FILES} files, ${mb(srcBytes)} MB`);
  console.log(`method reported: ${info.method}`);
  console.log(`  clone : ${cloneMs.toFixed(1)} ms` + (consumed != null ? `, ~${mb(Math.max(consumed, 0))} MB disk consumed (CoW shares blocks)` : ""));
  console.log(`  rsync : ${rsyncMs.toFixed(1)} ms, ~${mb(srcBytes)} MB copied (full byte copy)`);
  if (info.method === "clone") {
    console.log(`→ CoW clone is ${(rsyncMs / Math.max(cloneMs, 0.01)).toFixed(1)}× faster than the rsync mirror on this tree, near space-free`);
  } else {
    console.log(`→ clone unavailable here (cross-volume / non-APFS); used the rsync mirror honestly (method=${info.method})`);
  }
  await import("../src/snapshot.js").then((m) => m.drop("metrics-bench", src));
  rmSync(src, { recursive: true, force: true });
  rmSync(rdest, { recursive: true, force: true });
}

console.log("\nDeterministic dimensions (1 turns, 3 recall) are also asserted in test/smoke.ts.");

/** Free bytes on the volume holding `p`, or null if statfs is unavailable. */
function freeBytes(p: string): number | null {
  try {
    const s = statfsSync(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
