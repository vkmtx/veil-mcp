/**
 * Stress battery — drive the tools with adversarial / edge inputs across many areas
 * to SURFACE bugs (not a pass/fail gate). Each probe states the contract it expects;
 * a violation prints `ANOMALY` with detail. Boots a fresh server from src so it
 * tests the CURRENT code. Run: `tsx test/stress.ts` (or via sh_run).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const execSyncQuiet = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: "/bin/bash", stdio: "ignore" });

let anomalies = 0;
let probes = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  probes++;
  if (!cond) {
    anomalies++;
    console.log(`  ANOMALY: ${name}${detail ? " — " + detail : ""}`);
  }
}
const text = (r: any) => r.content[0].text;
const J = (r: any) => JSON.parse(text(r));

const serverEntry = new URL("../src/index.ts", import.meta.url).pathname;
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: { ...process.env } });
const client = new Client({ name: "stress", version: "0.0.0" });
await client.connect(transport);
const run = async (args: Record<string, unknown>) => J(await client.callTool({ name: "sh_run", arguments: args }));
const detail = async (args: Record<string, unknown>) => text(await client.callTool({ name: "sh_detail", arguments: args }));
const plan = async (command: string) => J(await client.callTool({ name: "sh_plan", arguments: { command } }));

// ── A. OUTPUT EXTREMES ────────────────────────────────────────────────────────
console.log("A. output extremes");
{
  const ansi = await run({ command: "printf '\\033[31mRED\\033[0m\\n\\033[1mBOLD\\033[0m\\n'" });
  ok("ansi: ok + content present", ansi.ok === true && typeof ansi.stdout === "string" && ansi.stdout.includes("RED"));

  const noNl = await run({ command: "printf 'no-newline-tail'" });
  ok("no trailing newline: 1 line counted", noNl.stdout_lines === 1, `got ${noNl.stdout_lines}`);
  ok("no trailing newline: content intact", noNl.stdout === "no-newline-tail", JSON.stringify(noNl.stdout));

  const longLine = await run({ command: "head -c 200000 /dev/zero | tr '\\0' x" }); // one 200k-char line, no newline
  ok("very long single line: not binary", !longLine.stdout_binary, "tr x is text");
  ok("very long single line: 1 emitted line", longLine.stdout_lines === 1, `got ${longLine.stdout_lines}`);

  const emoji = await run({ command: "printf '\\xf0\\x9f\\x9a\\x80 rocket\\n'" });
  ok("utf8 emoji: ok, not flagged binary", emoji.ok === true && !emoji.stdout_binary);

  const interleave = await run({ command: "for i in 1 2 3; do echo out$i; echo err$i 1>&2; done" });
  ok("interleaved streams: stdout has out lines", typeof interleave.stdout === "string" && interleave.stdout.includes("out3"));

  const onlyStderrOk = await run({ command: "echo note 1>&2; true" });
  ok("stderr-only success: ok true", onlyStderrOk.ok === true);
  ok("stderr-only success: stderr surfaced", typeof onlyStderrOk.stderr === "string" && onlyStderrOk.stderr.includes("note"));

  const empty = await run({ command: "true" });
  ok("empty output: no stdout field", !("stdout" in empty));
  ok("empty output: no stdout_lines", !("stdout_lines" in empty));
}

// ── B. EXIT / SIGNAL / TIMEOUT ────────────────────────────────────────────────
console.log("B. exit / signal / timeout");
{
  for (const code of [0, 1, 42, 255]) {
    const r = await run({ command: `exit ${code}` });
    ok(`exit ${code}: reported`, r.exit === code, `got ${r.exit}`);
    ok(`exit ${code}: ok flag`, r.ok === (code === 0));
  }
  const sig = await run({ command: "kill -TERM $$" });
  ok("SIGTERM self: non-zero exit", sig.ok === false, `exit ${sig.exit}`);

  const t1 = Date.now();
  const subshellTimeout = await run({ command: "(sleep 5)", timeout_ms: 400 });
  ok("subshell timeout: flagged", subshellTimeout.timed_out === true && subshellTimeout.exit === 124);
  ok("subshell timeout: fast", Date.now() - t1 < 3000, `${Date.now() - t1}ms`);

  const t2 = Date.now();
  const bgTimeout = await run({ command: "sleep 5 & wait", timeout_ms: 400 });
  ok("backgrounded timeout: flagged", bgTimeout.timed_out === true);
  ok("backgrounded timeout: fast", Date.now() - t2 < 3000, `${Date.now() - t2}ms`);
}

// ── C. EXPECT / ASSERT EDGES ──────────────────────────────────────────────────
console.log("C. expect / assert edges");
{
  const multi = await run({ command: "echo hi", expect: { exit: 0, stdout_contains: "hi", stderr_empty: true } });
  ok("expect multi all-pass", multi.assert_ok === true);

  const partial = await run({ command: "echo hi", expect: { exit: 0, stdout_contains: "BYE" } });
  ok("expect partial: assert_ok false", partial.assert_ok === false);
  ok("expect partial: only failed listed", Array.isArray(partial.assertions_failed) && partial.assertions_failed.length === 1);

  const badRe = await run({ command: "echo hi", expect: { stdout_matches: "(unclosed" } });
  ok("invalid regex: assert fails w/ detail", badRe.assert_ok === false && badRe.assertions_failed.some((a: string) => a.includes("invalid regex")));

  const spaceDir = mkdtempSync(join(tmpdir(), "veil stress ")); // spaces in path
  writeFileSync(join(spaceDir, "a b.txt"), "x");
  const spaceFile = await run({ command: "true", cwd: spaceDir, expect: { file_exists: "a b.txt" } });
  ok("file_exists with spaces in name+cwd", spaceFile.assert_ok === true);
  rmSync(spaceDir, { recursive: true, force: true });

  const matchNl = await run({ command: "printf 'line1\\nline2\\n'", expect: { stdout_matches: "line1[\\s\\S]*line2" } });
  ok("stdout_matches across newlines", matchNl.assert_ok === true);
}

// ── D. CLASSIFY / PLAN EXOTICA ────────────────────────────────────────────────
console.log("D. classify / plan exotica");
{
  const cases: [string, string][] = [
    ["sudo rm -rf /etc", "destructive"],
    ["env FOO=1 rm -rf x", "destructive"],
    ["nice -n 5 rm -fr y", "destructive"],
    ["ls", "read-only"],
    ["cat a | grep b", "complex"],
    // dangerous patterns are flagged even inside complex commands (the rm DOES run):
    ["echo $(rm -rf x)", "destructive"],
    ["true && rm -rf z", "destructive"],
    ["git push --force-with-lease", "destructive"],
    ["git stash", "mutating"], // stash mutates the worktree + stash stack
    ["git fetch --all", "network"],
    ["mv a b", "mutating"],
    ["cp -r a b", "mutating"],
    ["frobnicate", "unknown"],
    ["chmod -R 777 .", "mutating"],
  ];
  for (const [cmd, want] of cases) {
    const p = await plan(cmd);
    ok(`plan(${cmd}) = ${want}`, p.category === want, `got ${p.category}`);
  }
  // plan must never execute
  const probe = mkdtempSync(join(tmpdir(), "veil-planx-"));
  await plan(`touch ${join(probe, "SHOULD_NOT")}`);
  ok("plan does not execute", !existsSync(join(probe, "SHOULD_NOT")));
  rmSync(probe, { recursive: true, force: true });
}

// ── E. CHECKPOINT / RESTORE EDGES ─────────────────────────────────────────────
console.log("E. checkpoint / restore edges");
{
  const d = mkdtempSync(join(tmpdir(), "veil-ckpt-"));
  mkdirSync(join(d, "nested", "deep"), { recursive: true });
  writeFileSync(join(d, "nested", "deep", "f.txt"), "keep");
  writeFileSync(join(d, "name with space.txt"), "spaced");
  writeFileSync(join(d, "uni-café.txt"), "unicode");
  const cp = J(await client.callTool({ name: "sh_checkpoint", arguments: { label: "s1", dir: d } }));
  ok("checkpoint special names ok", cp.checkpointed === "s1");
  rmSync(join(d, "nested"), { recursive: true, force: true });
  rmSync(join(d, "name with space.txt"));
  writeFileSync(join(d, "added-after.txt"), "junk");
  await client.callTool({ name: "sh_restore", arguments: { label: "s1", dir: d } });
  ok("restore brings back nested", existsSync(join(d, "nested", "deep", "f.txt")));
  ok("restore brings back spaced name", existsSync(join(d, "name with space.txt")));
  ok("restore brings back unicode name", existsSync(join(d, "uni-café.txt")));
  ok("restore removes added-after", !existsSync(join(d, "added-after.txt")));
  rmSync(d, { recursive: true, force: true });

  // restore into a different dir must refuse
  const a = mkdtempSync(join(tmpdir(), "veil-cka-"));
  const b = mkdtempSync(join(tmpdir(), "veil-ckb-"));
  await client.callTool({ name: "sh_checkpoint", arguments: { label: "s2", dir: a } });
  const wrong = J(await client.callTool({ name: "sh_restore", arguments: { label: "s2", dir: b } }));
  ok("restore wrong dir refused", typeof wrong.error === "string" && wrong.error.includes("refusing"));
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
}

// ── F. STORE / DETAIL EDGES ───────────────────────────────────────────────────
console.log("F. store / detail edges");
{
  const big = await run({ command: "seq 1 500; echo MARKER_END" });
  const mEmpty = await detail({ id: big.id, selector: "stdout", match: "ZZZ_no_match" });
  ok("match no hits: header says 0", mEmpty.includes("0 line"));
  const mHit = await detail({ id: big.id, selector: "stdout", match: "MARKER_END" });
  ok("match hit: returns the line", mHit.includes("MARKER_END"));
  const unknownTrace = await detail({ id: big.id, selector: "trace" });
  ok("trace selector when none: graceful", unknownTrace.includes("no trace"));
  const unknownId = J(await client.callTool({ name: "sh_detail", arguments: { id: "cmd_nope" } }));
  ok("unknown id: error", typeof unknownId.error === "string" && unknownId.error.includes("unknown"));
  // match on a binary stream must be refused, not garbage
  const binRun = await run({ command: "head -c 64 /dev/zero" });
  const binMatch = J(await client.callTool({ name: "sh_detail", arguments: { id: binRun.id, selector: "stdout", match: "x" } }));
  ok("match on binary: refused", typeof binMatch.error === "string");
}

// ── G. CWD / ENV ──────────────────────────────────────────────────────────────
console.log("G. cwd / env");
{
  const noCwd = J(await client.callTool({ name: "sh_run", arguments: { command: "echo hi", cwd: "/no/such/dir/xyz" } }));
  ok("nonexistent cwd: errors, no crash", noCwd.ok === false || typeof noCwd.error === "string", JSON.stringify(noCwd).slice(0, 120));
  const spaceCwd = mkdtempSync(join(tmpdir(), "veil has space "));
  const inSpace = await run({ command: "pwd", cwd: spaceCwd });
  ok("cwd with spaces: runs", inSpace.ok === true);
  rmSync(spaceCwd, { recursive: true, force: true });
  const envExp = await run({ command: "echo $HOME" });
  ok("env expansion works", typeof envExp.stdout === "string" && envExp.stdout.trim().length > 0);
}

// ── H. SANDBOX (best-effort; only asserts where available) ────────────────────
console.log("H. sandbox (platform-gated)");
{
  const probe = await run({ command: "echo x", sandbox: true });
  if (probe.sandboxed) {
    const root = join(homedir(), `.veil-stress-sbx-${process.pid}`);
    const work = join(root, "work");
    mkdirSync(work, { recursive: true });
    // symlink escape attempt: a symlink inside cwd pointing outside
    const outside = join(root, "outside.txt");
    try { symlinkSync(outside, join(work, "link")); } catch { /* */ }
    const viaLink = await run({ command: "echo pwned > link", cwd: work, sandbox: true });
    ok("sandbox: symlink-escape write denied", !existsSync(outside), viaLink.ok ? "command ok but file?" : "");
    rmSync(root, { recursive: true, force: true });
  } else {
    ok("sandbox unavailable → refused/flagged", probe.sandbox_unavailable === true || probe.sandboxed === undefined);
  }
}

// ── I. RENDER / CONDENSE HONESTY ──────────────────────────────────────────────
console.log("I. render / condense honesty");
{
  const mid = await run({ command: "seq 1 100 | sed '50s/.*/FAIL build broke/'" });
  ok("mid-stream FAIL surfaced inline", typeof mid.stdout === "string" && mid.stdout.includes("FAIL build broke"));

  // a GIANT single line (no newlines) must not be dumped whole — condense is
  // line-based, so a 1-line 400KB blob would bypass the line cap. Inline must be bounded.
  const giant = await run({ command: "head -c 400000 /dev/zero | tr '\\0' x" });
  const giantLen = typeof giant.stdout === "string" ? giant.stdout.length : 0;
  ok("giant single line not dumped whole", giantLen < 50000, `inline ${giantLen} bytes`);

  // many medium lines but each very long — total inline should stay bounded too.
  const wide = await run({ command: "yes \"$(head -c 2000 /dev/zero | tr '\\0' y)\" | head -n 50" });
  const wideLen = typeof wide.stdout === "string" ? wide.stdout.length : 0;
  ok("wide condensed output bounded", wideLen < 50000, `inline ${wideLen} bytes`);

  const full = await run({ command: "seq 1 300", full: true });
  ok("full:true returns all lines", typeof full.stdout === "string" && full.stdout.split("\n").filter(Boolean).length === 300);

  const prog = await run({ command: "printf 'p1\\rp2\\rp3\\rdone\\n'" });
  ok("CR progress: final frame shown", typeof prog.stdout === "string" && prog.stdout.includes("done"));
}

// ── J. ASSERT EVALUATOR ───────────────────────────────────────────────────────
console.log("J. assert evaluator");
{
  const repo = mkdtempSync(join(tmpdir(), "veil-asrt-"));
  execSyncQuiet("git init -q && git config user.email t@t.co && git config user.name t", repo);
  writeFileSync(join(repo, "base.txt"), "b\n");
  execSyncQuiet("git add -A && git commit -qm init", repo);
  const ch = await run({ command: "echo x > new.txt", cwd: repo, expect: { changed: false } });
  ok("changed:false fails when it changed", ch.assert_ok === false);
  const arr = await run({ command: "true", cwd: repo, expect: { file_exists: ["new.txt", "missing.zzz"] } });
  ok("file_exists array partial → fails", arr.assert_ok === false);
  const abs = await run({ command: "true", cwd: repo, expect: { file_absent: "new.txt" } });
  ok("file_absent on existing → fails", abs.assert_ok === false);
  const slow = await run({ command: "sleep 0.3", expect: { max_ms: 50 } });
  ok("max_ms slow → fails with detail", slow.assert_ok === false && slow.assertions_failed.some((a: string) => a.includes("took")));
  const sp = await run({ command: "echo a.b.c", expect: { stdout_matches: "a\\.b\\.c" } });
  ok("stdout_matches escaped dots", sp.assert_ok === true);
  rmSync(repo, { recursive: true, force: true });
}

// ── K. SNAPSHOT SCALE + OVERWRITE ─────────────────────────────────────────────
console.log("K. snapshot scale + overwrite");
{
  const d = mkdtempSync(join(tmpdir(), "veil-snap-"));
  for (let i = 0; i < 300; i++) writeFileSync(join(d, `f${i}.txt`), `v${i}`);
  await client.callTool({ name: "sh_checkpoint", arguments: { label: "big", dir: d } });
  for (let i = 0; i < 150; i++) rmSync(join(d, `f${i}.txt`));
  writeFileSync(join(d, "extra.txt"), "x");
  await client.callTool({ name: "sh_restore", arguments: { label: "big", dir: d } });
  ok("restore brings back all 300", existsSync(join(d, "f0.txt")) && existsSync(join(d, "f149.txt")) && existsSync(join(d, "f299.txt")));
  ok("restore removes added-after", !existsSync(join(d, "extra.txt")));
  // overwrite same label, then restore reflects the NEW snapshot
  writeFileSync(join(d, "v2only.txt"), "x");
  await client.callTool({ name: "sh_checkpoint", arguments: { label: "big", dir: d } });
  rmSync(join(d, "v2only.txt"));
  await client.callTool({ name: "sh_restore", arguments: { label: "big", dir: d } });
  ok("overwrite checkpoint reflects new state", existsSync(join(d, "v2only.txt")));
  rmSync(d, { recursive: true, force: true });
}

// ── L. CONCURRENCY / id + store ───────────────────────────────────────────────
console.log("L. concurrency / id + store");
{
  const N = 30;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => run({ command: `echo conc${i}` })));
  const ids = new Set(results.map((r) => r.id));
  ok("concurrent: distinct ids", ids.size === N, `${ids.size}/${N}`);
  let recovered = 0;
  for (let i = 0; i < N; i++) {
    const got = await detail({ id: results[i].id, selector: "stdout" });
    if (got.includes(`conc${i}`)) recovered++;
  }
  ok("concurrent: every id recovers its own output", recovered === N, `${recovered}/${N}`);
}

// ── M. SOAK / RESOURCES ───────────────────────────────────────────────────────
console.log("M. soak / resources");
{
  // ~700KB of real lines: condensed inline must stay bounded, full recoverable, and
  // NOT truncated (under the 5MB cap), with a true line count.
  const big = await run({ command: "seq 1 120000" });
  ok("700KB: condensed inline bounded", typeof big.stdout === "string" && big.stdout.length < 5000, `${typeof big.stdout === "string" ? big.stdout.length : 0}B`);
  ok("700KB: not truncated under 5MB cap", !big.stdout_truncated);
  ok("700KB: true emitted line count", big.stdout_lines === 120000, `got ${big.stdout_lines}`);
  const rec = await detail({ id: big.id, selector: "stdout" });
  ok("700KB: fully recoverable via sh_detail", rec.split("\n").filter(Boolean).length === 120000);

  // emit-then-linger: sh_run waits for process exit and returns the full output.
  const linger = await run({ command: "printf 'early\\n'; sleep 0.3; printf 'late\\n'" });
  ok("emit-then-linger: both lines present", typeof linger.stdout === "string" && linger.stdout.includes("early") && linger.stdout.includes("late"));

  // 25 rapid sequential runs — the store must keep each addressable under churn.
  let allRec = true;
  for (let i = 0; i < 25; i++) {
    const r = await run({ command: `seq 1 2000; echo TAG${i}` });
    const d = await detail({ id: r.id, selector: "stdout" });
    if (!d.includes(`TAG${i}`)) allRec = false;
  }
  ok("25 rapid runs: each stays recoverable", allRec);
}

await client.close();
console.log(`\n${probes} probes, ${anomalies} anomalies`);
process.exit(0); // report-only; never fail the run
