/**
 * End-to-end smoke test: boot the server over stdio, exercise both tools, assert
 * the contract. Exits non-zero on any failed assertion.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { condense, lineCount } from "../src/render.js";
import { extractSignals } from "../src/signals.js";
import { diffStatus, effectsFromTrace } from "../src/effects.js";
import { sandboxAvailable, buildProfile, buildBwrapArgs } from "../src/policy.js";
import { looksInteractive, classify } from "../src/classify.js";
import { traceAvailable, buildTraceCommand, summarizeTrace } from "../src/trace.js";
import { runInit } from "../src/init.js";
import { config } from "../src/config.js";

// Isolate the on-disk record store for the whole test: child servers inherit this
// env, so they never touch the real ~/.local/state/veil. Cleaned up at exit.
const STATE_BASE = mkdtempSync(join(tmpdir(), "veil-smoke-state-"));
process.env.VEIL_STATE_DIR = STATE_BASE;

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}
function text(r: any): string {
  return r.content[0].text;
}

// ── Unit tests: pure render/signal logic (no server) ───────────────────────────
// lineCount honesty, including CR-overwrite progress frames and CRLF.
check("lineCount counts lines w/ and w/o trailing newline", lineCount("a\nb") === 2 && lineCount("a\nb\n") === 2 && lineCount("") === 0);
check("lineCount treats CRLF as one separator", lineCount("a\r\nb\r\n") === 2);
check("lineCount collapses CR progress frames to one line", lineCount("a\rb\rc") === 1);

// condense threshold boundary (inclusive lower bound AND the elision edge).
const atThreshold = condense(Array.from({ length: config.inlineMaxLines }, (_, i) => `l${i}`).join("\n"), "u", "stdout");
check("condense passes whole at inlineMaxLines", !atThreshold.includes("lines hidden"));
const overThreshold = condense(Array.from({ length: config.inlineMaxLines + 1 }, (_, i) => `l${i}`).join("\n"), "u", "stdout");
check("condense elides at inlineMaxLines+1", overThreshold.includes("lines hidden"));
const beyond = condense(Array.from({ length: config.headLines + config.tailLines + 20 }, (_, i) => `l${i}`).join("\n"), "u", "stdout");
check("condense elides beyond head+tail", beyond.includes("20 lines hidden"));

// short streams: CR-free byte-identical; CR-overwrite frames collapse to last frame.
check("condense passes short CR-free stream byte-identical", condense("alpha\nbeta\ngamma", "u", "stdout") === "alpha\nbeta\ngamma");
check("condense collapses short CR progress frames", condense("a\rb\rc", "u", "stdout") === "c");
// a giant single line (no newlines) must be width-capped, not dumped whole.
const capped = condense("y".repeat(50000), "u9", "stdout");
check("condense width-caps a giant single line", capped.length < 5000 && capped.includes("sh_detail"));

// effects: a git-add of a dirty file (" M f" -> "M  f") is a status transition, NOT a revert.
const transition = diffStatus(new Set([" M f"]), new Set(["M  f"]));
check("git-add of dirty file not phantom-reverted", Array.isArray(transition) && transition.some((l) => l.includes("f")) && !transition.some((l) => l.includes("reverted")));

// policy (K): sandbox profile shape + availability.
check("sandboxAvailable true on macOS", process.platform !== "darwin" || sandboxAvailable() === true);
// K+ Linux backend (bubblewrap) — pure arg-builder, verifiable on any platform.
const bw = buildBwrapArgs("echo hi", "/tmp/work", {});
check("bwrap ro-binds root, binds + chdir cwd, runs via sh", bw.includes("--ro-bind / /") && bw.includes("--bind") && bw.includes("--chdir") && bw.includes("/bin/sh -c"));
check("bwrap unshare-net only when network denied", buildBwrapArgs("x", "/tmp/w", { network: false }).includes("--unshare-net") && !buildBwrapArgs("x", "/tmp/w", {}).includes("--unshare-net"));

// feature A — trace summarizer (the testable core) + platform detection.
check("traceAvailable false off Linux", process.platform === "linux" || traceAvailable() === false);
check("buildTraceCommand null when no tracer", process.platform === "linux" || buildTraceCommand("echo x", "/tmp/t") === null);
const trSum = summarizeTrace('openat(AT_FDCWD, "/etc/hosts", O_RDONLY) = 3\nopenat(AT_FDCWD, "/tmp/out.txt", O_WRONLY|O_CREAT, 0644) = 4\nstat("/x") = 0');
check("summarizeTrace splits reads vs writes", trSum.wrote.includes("/tmp/out.txt") && trSum.read.includes("/etc/hosts") && trSum.syscalls === 3);
// strace -f interrupted syscalls print "<unfinished ...>"; the flags precede it, so writes aren't lost.
const trUnfin = summarizeTrace('[pid 9] openat(AT_FDCWD, "/tmp/u.txt", O_WRONLY|O_CREAT <unfinished ...>');
check("summarizeTrace catches unfinished write line", trUnfin.wrote.includes("/tmp/u.txt"));
// effects-from-trace: cwd-scoped writes become files_changed (replaces git when tracing).
const fxTrace = effectsFromTrace(["/work/a.txt", "/work/sub/b.txt", "/etc/passwd", "/work/a.txt"], "/work");
check("effectsFromTrace scopes to cwd, relativizes, dedupes", fxTrace.includes("wrote a.txt") && fxTrace.includes("wrote sub/b.txt") && !fxTrace.some((l) => l.includes("passwd")) && fxTrace.length === 2);

// ── classify: top-level pipeline/list decomposition (mitigation #2) ─────────────
// A pipeline of read-onlys is read-only — no longer an opaque "complex".
check("classify pipeline of read-onlys is read-only", classify("cat f | grep x | wc -l").category === "read-only");
// Worst-case wins the label: cd (unknown) + cp (mutating) → mutating.
check("classify list aggregates to worst-case (mutating)", classify("cd build && cp a b").category === "mutating");
// Destructiveness is caught at the SEGMENT level, even without a force flag.
check("classify segment-level rm is destructive", classify("echo go && rm file").category === "destructive");
check("classify rm -rf inside a list is destructive", classify("cd x && rm -rf dist").category === "destructive");
// Genuinely undecidable constructs stay honestly "complex".
check("classify command substitution stays complex", classify("echo $(whoami)").category === "complex");
check("classify redirect stays complex (honest limit)", classify("echo hi > out.txt").category === "complex");
// A quoted operator must NOT be treated as a split point.
check("classify ignores operators inside quotes", classify('echo "a && b"').category === "read-only");
// Single commands are unchanged by the new path.
check("classify single command unchanged", classify("ls -la").category === "read-only" && classify("rm file").category === "destructive");
// find's blast radius is its ACTION, not the binary — never under-flag an -exec payload (review #1).
check("classify find -exec shred destructive", classify("find . -type f -exec shred {} \\;").category === "destructive");
check("classify find -execdir rm destructive", classify("find . -execdir rm {} +").category === "destructive");
check("classify find -exec /bin/rm destructive", classify("find . -exec /bin/rm {} \\;").category === "destructive");
check("classify find -exec git reset --hard destructive", classify("find . -type d -exec git reset --hard \\;").category === "destructive");
check("classify find -exec cat stays read-only (no over-flag)", classify("find . -exec cat {} \\;").category === "read-only");
check("classify plain find stays read-only", classify("find . -name '*.ts'").category === "read-only");
// quoted git subcommand must classify like the bare form (review #2).
check("classify quoted git reset --hard destructive", classify('git "reset" --hard').category === "destructive");
check("classify quoted git clean -fd destructive", classify("git 'clean' -fd").category === "destructive");
check("classify quoted git push --force destructive", classify('git "push" --force').category === "destructive");

// ── veil init: idempotent per-project nudge (mitigation #1) ─────────────────────
const initDir = mkdtempSync(join(tmpdir(), "veil-init-"));
runInit(initDir);
const initFile = join(initDir, "CLAUDE.md");
check("veil init creates CLAUDE.md with the sh_run nudge", existsSync(initFile) && readFileSync(initFile, "utf8").includes("sh_run"));
const afterFirst = readFileSync(initFile, "utf8");
runInit(initDir); // second run must not duplicate the block
const afterSecond = readFileSync(initFile, "utf8");
check("veil init is idempotent (one marked block, byte-stable)", (afterSecond.match(/veil-mcp:start/g) || []).length === 1 && afterSecond === afterFirst);
// Appends (does not clobber) an existing CLAUDE.md.
const initDir2 = mkdtempSync(join(tmpdir(), "veil-init2-"));
writeFileSync(join(initDir2, "CLAUDE.md"), "# Existing project rules\n\nKeep me.\n");
runInit(initDir2);
const merged = readFileSync(join(initDir2, "CLAUDE.md"), "utf8");
check("veil init preserves an existing CLAUDE.md", merged.includes("Keep me.") && merged.includes("veil-mcp:start"));
// An orphan start marker (truncated/hand-edited block) must still get a working block (review #9).
const initDir3 = mkdtempSync(join(tmpdir(), "veil-init3-"));
writeFileSync(join(initDir3, "CLAUDE.md"), "# rules\n<!-- veil-mcp:start -->\norphan, no end marker\n# more\n");
runInit(initDir3);
const repaired = readFileSync(join(initDir3, "CLAUDE.md"), "utf8");
check("veil init repairs an orphan start marker (appends a complete block)", repaired.includes("<!-- veil-mcp:end -->") && repaired.includes("sh_run"));
rmSync(initDir, { recursive: true, force: true });
rmSync(initDir2, { recursive: true, force: true });
rmSync(initDir3, { recursive: true, force: true });
const prof = buildProfile("/tmp/xcwd", {});
check("profile confines writes and re-allows cwd", prof.includes("(deny file-write*)") && prof.includes("/tmp/xcwd"));
check("profile denies network only when asked", buildProfile("/tmp/x", { network: false }).includes("(deny network*)") && !buildProfile("/tmp/x", {}).includes("(deny network*)"));
let profThrew = false;
try { buildProfile("/tmp/x", { writable: ["/bad'quote"] }); } catch { profThrew = true; }
check("profile rejects single-quote path", profThrew);
let dqThrew = false;
try { buildProfile("/tmp/x", { writable: ['/bad"q'] }); } catch { dqThrew = true; }
check("profile rejects double-quote path", dqThrew);

// interactive-command detector (advisory only).
check("looksInteractive flags editor", looksInteractive("vim file.txt") === true);
check("looksInteractive flags bare REPL", looksInteractive("python") === true && looksInteractive("python script.py") === false);
check("looksInteractive flags ssh login but not remote cmd", looksInteractive("ssh host") === true && looksInteractive("ssh host ls") === false);
check("looksInteractive ignores normal + piped", looksInteractive("ls -la") === false && looksInteractive("echo x | less") === false);

// signal surfacing: a mid-stream FAIL must not be eaten by head+tail elision.
check("extractSignals finds failure lines", extractSignals(["info", "FAILED test_x", "ok"]).some((l) => l.includes("FAILED test_x")));
const midFail = Array.from({ length: 100 }, (_, i) => (i === 50 ? "ERROR boom in the middle" : `line ${i}`)).join("\n");
const midCondensed = condense(midFail, "u", "stdout");
check("condense surfaces mid-stream ERROR", midCondensed.includes("ERROR boom in the middle") && midCondensed.includes("flagged"));
// crash/failure idioms that contain no "error"/"fail" token must still surface.
for (const idiom of ["Segmentation fault (core dumped)", "SIGSEGV", "Aborted", "Killed", "CONFLICT (content): Merge conflict in x", "! [rejected] main -> main", "undefined reference to `foo`", "ld: symbol(s) not found", "Operation timed out", "found 3 high severity vulnerabilities"]) {
  check(`signals surfaces ${JSON.stringify(idiom)}`, extractSignals([idiom]).length === 1);
}
check("signals ignores a benign line (no over-flag)", extractSignals(["compiling module ok"]).length === 0);
// more distinct mid-stream signals than the inline cap must be COUNTED, not
// silently dropped: the marker reports the true total plus an overflow note.
const manySignals = Array.from({ length: 60 }, (_, i) => (i >= 25 && i < 33 ? `ERROR case ${i}` : `line ${i}`)).join("\n");
const manyCondensed = condense(manySignals, "u", "stdout");
check("condense reports true flagged total beyond the inline cap", manyCondensed.includes("8 flagged") && manyCondensed.includes("+3 more"));

// truncation honesty: marker present, torn first fragment dropped.
const truncRendered = condense("torn-fragment-line\nreal line A\nreal line B", "u9", "stdout", { truncated: true });
check("condense marks truncation and drops torn fragment", truncRendered.includes("truncated at byte cap") && !truncRendered.includes("torn-fragment-line"));

const serverEntry = new URL("../src/index.ts", import.meta.url).pathname;
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry] });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
check("lists sh_run + sh_detail", tools.includes("sh_run") && tools.includes("sh_detail"));

// 1) quiet success, short output returned whole
const a = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo hello && echo world" } })));
check("short success ok", a.ok === true && a.exit === 0);
check("short stdout returned whole", a.stdout === "hello\nworld");

// 2) verbose output condensed to head+tail
const b = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "seq 1 200" } })));
check("verbose stdout_lines counted", b.stdout_lines === 200);
check("verbose stdout condensed", b.stdout.includes("lines hidden"));

// 3) addressable detail recovers full output without re-running
const d = text(await client.callTool({ name: "sh_detail", arguments: { id: b.id, selector: "stdout" } }));
check("sh_detail recovers full output", d.split("\n").filter(Boolean).length === 200);

// 4) failure surfaces stderr + hint
const f = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "ls /no/such/path" } })));
check("failure ok=false", f.ok === false && f.exit !== 0);
check("failure has hint", typeof f.hint === "string");
check("failure surfaces stderr", typeof f.stderr === "string" && f.stderr.length > 0);

// 5) timeout enforced
const t0 = Date.now();
const t = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "sleep 5", timeout_ms: 500 } })));
check("timeout flagged", t.timed_out === true && t.exit === 124);
check("timeout actually fast", Date.now() - t0 < 4000);

// 5b) timeout must kill a COMPOUND command's grandchildren, not just the shell.
// Regression: a `;`-joined command forks a child the shell doesn't exec into; a
// shell-only kill orphans it and the run blocks the full duration. (bug found v0.2)
const t1 = Date.now();
const tc = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "sleep 5; echo done", timeout_ms: 500 } })));
check("compound timeout flagged", tc.timed_out === true && tc.exit === 124);
check("compound timeout actually fast", Date.now() - t1 < 4000);

// 6) effect diff in a real git repo
const repo = mkdtempSync(join(tmpdir(), "veil-"));
execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: repo, shell: "/bin/bash" });
writeFileSync(join(repo, "a.txt"), "base\n");
execSync("git add -A && git commit -qm init", { cwd: repo, shell: "/bin/bash" });
const e = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo new > b.txt && echo more >> a.txt", cwd: repo } })));
check("effect diff lists modified + new", Array.isArray(e.files_changed) && e.files_changed.some((l: string) => l.includes("a.txt")) && e.files_changed.some((l: string) => l.includes("b.txt")));
// deleting an untracked file reads as a deletion, not a "(reverted)" rollback. (bug found v0.2)
writeFileSync(join(repo, "scratch.txt"), "tmp\n");
const del = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "rm scratch.txt", cwd: repo } })));
check("untracked deletion not labeled reverted", Array.isArray(del.files_changed) && del.files_changed.some((l: string) => l.includes("deleted") && l.includes("scratch.txt")) && !del.files_changed.some((l: string) => l.includes("reverted")));
rmSync(repo, { recursive: true, force: true });

// 7) assertions — passing post-conditions
const p = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo ready", expect: { exit: 0, stdout_contains: "ready" } } })));
check("assert_ok true when conditions met", p.assert_ok === true && p.assertions_failed === undefined);

// 8) assertions — failing post-condition surfaces despite exit 0
const q = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo ok", expect: { stdout_contains: "MISSING" } } })));
check("assert_ok false on unmet condition", q.ok === true && q.assert_ok === false);
check("failed assertion listed", Array.isArray(q.assertions_failed) && q.assertions_failed.length === 1);
check("assertion failure produces hint", typeof q.hint === "string");

// 9) file_exists assertion against a real path
const fe = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "true", cwd: process.cwd(), expect: { file_exists: "package.json", file_absent: "nope.xyz" } } })));
check("file_exists + file_absent pass", fe.assert_ok === true);

// 10) retry (M) — a command that fails then is retried, attempts reported
const repo2 = mkdtempSync(join(tmpdir(), "veil-retry-"));
const flag = join(repo2, "flag");
const retryCmd = `test -f ${flag} && echo ok || (touch ${flag}; exit 1)`;
const rr = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: retryCmd, cwd: repo2, retries: 1 } })));
check("retry succeeds on 2nd attempt", rr.ok === true && rr.attempts === 2);
rmSync(repo2, { recursive: true, force: true });

// 11) retry respects retry_on_exit (no retry on non-listed code)
const nr = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "exit 3", retries: 2, retry_on_exit: [1] } })));
check("no retry when exit not in retry_on_exit", nr.exit === 3 && nr.attempts === undefined);

// 12) sh_plan (B + K-lite) — classification without execution
const planRm = JSON.parse(text(await client.callTool({ name: "sh_plan", arguments: { command: "rm -rf build" } })));
check("plan flags destructive", planRm.category === "destructive" && typeof planRm.warning === "string");
const planLs = JSON.parse(text(await client.callTool({ name: "sh_plan", arguments: { command: "ls -la" } })));
check("plan marks read-only", planLs.category === "read-only");
const planPipe = JSON.parse(text(await client.callTool({ name: "sh_plan", arguments: { command: "cat a | grep b > c" } })));
check("plan marks complex on shell ops", planPipe.category === "complex");
// plan must not execute: target file must not appear
const planDir = mkdtempSync(join(tmpdir(), "veil-plan-"));
await client.callTool({ name: "sh_plan", arguments: { command: `touch ${join(planDir, "should_not_exist")}` } });
check("plan does not execute", !existsSync(join(planDir, "should_not_exist")));
rmSync(planDir, { recursive: true, force: true }); // don't leak the temp dir

// 12b) git is classified per-subcommand, not as a blanket read-only binary.
// Regression: `git push --force` / `git reset --hard` previously read as read-only. (bug found v0.2)
const gitPush = JSON.parse(text(await client.callTool({ name: "sh_plan", arguments: { command: "git push origin main --force" } })));
check("plan flags force-push destructive", gitPush.category === "destructive" && typeof gitPush.warning === "string");
const gitReset = JSON.parse(text(await client.callTool({ name: "sh_plan", arguments: { command: "git reset --hard HEAD~3" } })));
check("plan flags reset --hard destructive", gitReset.category === "destructive");
const gitStatus = JSON.parse(text(await client.callTool({ name: "sh_plan", arguments: { command: "git status -s" } })));
check("plan keeps git status read-only", gitStatus.category === "read-only");
const gitClean = JSON.parse(text(await client.callTool({ name: "sh_plan", arguments: { command: "git clean -fd" } })));
check("plan flags git clean -fd destructive", gitClean.category === "destructive");

// 12c) raw block-device redirect is destructive (the prior \b>-anchored regex was dead). (bug found v0.2)
const devWrite = JSON.parse(text(await client.callTool({ name: "sh_plan", arguments: { command: "echo wipe > /dev/sda" } })));
check("plan flags raw-device write destructive", devWrite.category === "destructive");

// 13) checkpoint + restore (C) — undo a deletion
const ckptDir = mkdtempSync(join(tmpdir(), "veil-ckpt-"));
writeFileSync(join(ckptDir, "keep.txt"), "important\n");
const cp = JSON.parse(text(await client.callTool({ name: "sh_checkpoint", arguments: { label: "pre", dir: ckptDir } })));
check("checkpoint created", cp.checkpointed === "pre");
check("checkpoint uses APFS CoW clone on macOS", process.platform !== "darwin" || cp.method === "clone");
rmSync(join(ckptDir, "keep.txt")); // simulate a mistake
writeFileSync(join(ckptDir, "junk.txt"), "oops\n"); // and a stray file
const rs = JSON.parse(text(await client.callTool({ name: "sh_restore", arguments: { label: "pre", dir: ckptDir } })));
check("restore reported", rs.restored === "pre");
check("restore brings back deleted file", existsSync(join(ckptDir, "keep.txt")));
check("restore removes files created after checkpoint", !existsSync(join(ckptDir, "junk.txt")));
const cl = JSON.parse(text(await client.callTool({ name: "sh_checkpoints", arguments: {} })));
check("checkpoints listed", Array.isArray(cl.checkpoints) && cl.checkpoints.includes("pre"));
rmSync(ckptDir, { recursive: true, force: true });

// ── 14) mid-stream FAIL surfaced inline despite condensing (quality concern #1) ──
const midRun = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "seq 1 100 | sed '50s/.*/FAIL build broke/'" } })));
check("e2e mid-stream FAIL surfaced", midRun.stdout.includes("FAIL build broke") && midRun.stdout.includes("lines hidden"));

// ── 15) full:true escape hatch returns uncondensed output ──
const fullRun = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "seq 1 200", full: true } })));
check("full:true uncondensed", fullRun.stdout.split("\n").filter(Boolean).length === 200 && !fullRun.stdout.includes("lines hidden"));

// ── 16) retry exhaustion + backoff + positive retry_on_exit ──
const exhaust = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "exit 1", retries: 2 } })));
check("retry exhaustion reports all attempts", exhaust.ok === false && exhaust.exit === 1 && exhaust.attempts === 3);
const bt0 = Date.now();
const backoff = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "exit 1", retries: 1, backoff_ms: 200 } })));
check("backoff delays between attempts", backoff.attempts === 2 && Date.now() - bt0 >= 180);
const repo3 = mkdtempSync(join(tmpdir(), "veil-retry2-"));
const flag2 = join(repo3, "flag2");
const rp = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: `test -f ${flag2} && echo ok || (touch ${flag2}; exit 2)`, cwd: repo3, retries: 2, retry_on_exit: [2] } })));
check("retry_on_exit positive match retries then succeeds", rp.ok === true && rp.attempts === 2);
rmSync(repo3, { recursive: true, force: true });

// ── 17) assertion keys not covered above ──
const sm = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo hello", expect: { stdout_matches: "^hel" } } })));
check("stdout_matches valid passes", sm.assert_ok === true);
const smBad = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo hi", expect: { stdout_matches: "(" } } })));
check("stdout_matches invalid regex fails with detail", smBad.assert_ok === false && smBad.assertions_failed.some((a: string) => a.includes("invalid regex")));
const seEmpty = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo x", expect: { stderr_empty: true } } })));
check("stderr_empty true passes on clean stderr", seEmpty.assert_ok === true);
const seFail = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo e 1>&2", expect: { stderr_empty: true } } })));
check("stderr_empty true fails when stderr present", seFail.assert_ok === false);
const sePol = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo e 1>&2", expect: { stderr_empty: false } } })));
check("stderr_empty false polarity passes", sePol.assert_ok === true);
const mxFail = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "sleep 1", expect: { max_ms: 50 } } })));
check("max_ms fail reports took", mxFail.assert_ok === false && mxFail.assertions_failed.some((a: string) => a.includes("took")));
const mxOk = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo q", expect: { max_ms: 5000 } } })));
check("max_ms pass", mxOk.assert_ok === true);
const feArr = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "true", cwd: process.cwd(), expect: { file_exists: ["package.json", "src/index.ts"] } } })));
check("file_exists array passes", feArr.assert_ok === true);
const cgRepo = mkdtempSync(join(tmpdir(), "veil-chg-"));
execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: cgRepo, shell: "/bin/bash" });
writeFileSync(join(cgRepo, "a.txt"), "x\n");
execSync("git add -A && git commit -qm init", { cwd: cgRepo, shell: "/bin/bash" });
const chgTrue = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo more >> a.txt", cwd: cgRepo, expect: { changed: true } } })));
check("changed:true passes when tree changes", chgTrue.assert_ok === true);
rmSync(cgRepo, { recursive: true, force: true });
const chgNoGit = mkdtempSync(join(tmpdir(), "veil-nogit-"));
const chgNg = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "true", cwd: chgNoGit, expect: { changed: true } } })));
check("changed in non-git dir fails with detail", chgNg.assert_ok === false && chgNg.assertions_failed.some((a: string) => a.includes("not a git repo")));
rmSync(chgNoGit, { recursive: true, force: true });

// ── 18) classify taxonomy via sh_plan ──
const P = async (c: string) => JSON.parse(text(await client.callTool({ name: "sh_plan", arguments: { command: c } })));
check("plan dd destructive", (await P("dd if=/dev/zero of=x")).category === "destructive");
check("plan mkfs destructive", (await P("mkfs.ext4 /dev/sdb")).category === "destructive");
check("plan rm split flags destructive", (await P("rm -r -f /tmp/x")).category === "destructive");
check("plan rm -fr (f not last in cluster) destructive", (await P("rm -fr /tmp/x")).category === "destructive");
check("plan sudo rm -r -f destructive (unwrap)", (await P("sudo rm -r -f /etc")).category === "destructive");
check("plan fork bomb destructive", (await P(":(){ :|:& };:")).category === "destructive");
check("plan git -C push --force destructive", (await P("git -C /tmp/r push --force")).category === "destructive");
check("plan git checkout mutating", (await P("git checkout .")).category === "mutating");
check("plan git rebase destructive", (await P("git rebase -i HEAD~2")).category === "destructive");
check("plan git branch -D destructive", (await P("git branch -D feat")).category === "destructive");
check("plan git fetch network", (await P("git fetch")).category === "network");
const gadd = await P("git add -A");
check("plan git add mutating reversible", gadd.category === "mutating" && gadd.reversible === true);
check("plan unknown git sub", (await P("git frobnicate")).category === "unknown");
const mvp = await P("mv a b");
check("plan mv move", mvp.category === "mutating" && mvp.mutations[0].op === "move");
const cpt = await P("cp -t /dest a b");
check("plan cp -t dest detection", cpt.mutations[0].paths[0] === "/dest");
check("plan rmdir mutating", (await P("rmdir d")).category === "mutating");
check("plan curl network", (await P("curl http://x")).category === "network");
const chm = await P("chmod 755 f");
check("plan chmod modify", chm.category === "mutating" && chm.mutations[0].op === "modify");
check("plan rm no -f still destructive", (await P("rm file")).category === "destructive");
const fro = await P("frobnicate --x");
check("plan unknown binary", fro.category === "unknown" && typeof fro.note === "string");
// classify hardening (stress/fuzz battery findings):
check("plan shred destructive", (await P("shred -uvz secret.key")).category === "destructive");
check("plan truncate -s 0 destructive", (await P("truncate -s 0 prod.log")).category === "destructive");
check("plan truncate (resize) mutating", (await P("truncate -s 1M f")).category === "mutating");
check("plan mkfifo mutating", (await P("mkfifo /tmp/p")).category === "mutating");
check("plan find -delete destructive", (await P("find . -name '*.tmp' -delete")).category === "destructive");
check("plan find -exec rm destructive", (await P("find . -type f -exec rm {} ;")).category === "destructive");
check("plan sed -i mutating", (await P("sed -i 's/a/b/' f.txt")).category === "mutating");
check("plan sed (stream) read-only", (await P("sed 's/a/b/' f.txt")).category === "read-only");
check("plan sftp network", (await P("sftp -b batch user@host")).category === "network");
check("plan git rm mutating", (await P("git rm --cached f")).category === "mutating");
check("plan git branch -d mutating", (await P("git branch -d feature")).category === "mutating");
check("plan git tag -d mutating", (await P("git tag -d v1.0")).category === "mutating");
check("plan git remote remove mutating", (await P("git remote remove origin")).category === "mutating");
check("plan git push --delete destructive", (await P("git push origin --delete stale")).category === "destructive");
check("plan git stash clear destructive", (await P("git stash clear")).category === "destructive");
check("plan git checkout -- discards (destructive)", (await P("git checkout -- src/main.c")).category === "destructive");
// wrapper value-arg unwrap: the real command must be reached past timeout/nice values.
check("plan timeout DURATION git push --force destructive", (await P("timeout 5 git push --force origin main")).category === "destructive");
check("plan nice -n N curl network", (await P("nice -n 5 curl http://x")).category === "network");
check("plan xargs -I {} rm destructive", (await P("xargs -I {} rm {}")).category === "destructive");
check("plan busybox rm destructive", (await P("busybox rm /tmp/x")).category === "destructive");

// ── 18b) effect-diff skip for read-only (#2) + destructive sandbox advice (#3) ──
const roLs = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "ls", cwd: process.cwd() } })));
check("read-only run omits files_changed", !("files_changed" in roLs));
const roChg = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "ls", cwd: process.cwd(), expect: { changed: false } } })));
check("read-only + changed assert still forces effect-diff", roChg.assert_ok === true);
// Fresh server so the rm is the FIRST destructive-unconfined call (the nudge is once-per-process).
const advT = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: { ...process.env } });
const advC = new Client({ name: "smoke-adv", version: "0.0.0" });
await advC.connect(advT);
const advDir = mkdtempSync(join(tmpdir(), "veil-adv-"));
writeFileSync(join(advDir, "victim.txt"), "x\n");
const destr = JSON.parse(text(await advC.callTool({ name: "sh_run", arguments: { command: "rm victim.txt", cwd: advDir } })));
check("destructive unconfined gets one-time advice", typeof destr.advice === "string" && destr.advice.includes("sandbox"));
const destr2 = JSON.parse(text(await advC.callTool({ name: "sh_run", arguments: { command: "rm -r victim2", cwd: advDir } })));
check("destructive advice is once-per-session (no repeat)", !("advice" in destr2));
const roNoAdv = JSON.parse(text(await advC.callTool({ name: "sh_run", arguments: { command: "ls", cwd: advDir } })));
check("non-destructive gets no advice", !("advice" in roNoAdv));
rmSync(advDir, { recursive: true, force: true });
await advC.close();

// ── 19) quiet contract: trivial success omits zero/default fields ──
const qd = mkdtempSync(join(tmpdir(), "veil-quiet-"));
const quiet = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo done", cwd: qd } })));
check("quiet omits noise fields", !("stderr_lines" in quiet) && !("files_changed" in quiet) && !("timed_out" in quiet) && !("stdout_truncated" in quiet) && !("attempts" in quiet) && !("assert_ok" in quiet));
rmSync(qd, { recursive: true, force: true });

// ── 20) stderr condensing on success + off-by-one boundary on failure ──
const okStderr = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "seq 1 60 1>&2; true" } })));
check("success large stderr condensed", okStderr.ok === true && typeof okStderr.stderr === "string" && okStderr.stderr.includes("lines hidden"));
const boundary = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: `seq 1 ${config.stderrInlineOnFail} 1>&2; false` } })));
check("failure stderr at limit shown whole (off-by-one fix)", boundary.ok === false && !boundary.stderr.includes("lines hidden"));
const overLimit = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: `seq 1 ${config.stderrInlineOnFail + 10} 1>&2; false` } })));
check("failure stderr over limit condensed", overLimit.ok === false && overLimit.stderr.includes("lines hidden"));

// ── 21) sh_detail meta outside a repo, stderr selector, unknown id ──
const metaDir = mkdtempSync(join(tmpdir(), "veil-meta-"));
const mrun = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo hi", cwd: metaDir } })));
const meta = JSON.parse(text(await client.callTool({ name: "sh_detail", arguments: { id: mrun.id, selector: "meta" } })));
check("meta core fields + attempts", meta.id === mrun.id && meta.exit === 0 && meta.attempts === 1 && meta.stdout_truncated === false);
check("meta files_changed n/a outside repo", meta.files_changed === "n/a (not a git repo)");
rmSync(metaDir, { recursive: true, force: true });
const ferr = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "ls /no/such/path" } })));
const se = text(await client.callTool({ name: "sh_detail", arguments: { id: ferr.id, selector: "stderr" } }));
check("stderr selector returns text", typeof se === "string" && se.length > 0);
const unk = JSON.parse(text(await client.callTool({ name: "sh_detail", arguments: { id: "cmd999999" } })));
check("unknown id error", typeof unk.error === "string" && unk.error.includes("unknown id"));

// ── 21b) sh_detail match — grep stored output for a value condensing hid (mitigation A) ──
const big = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "seq 1 300; echo NEEDLE_42" } })));
const grep = text(await client.callTool({ name: "sh_detail", arguments: { id: big.id, selector: "stdout", match: "NEEDLE" } }));
check("sh_detail match returns only the matching line", grep.includes("NEEDLE_42") && grep.includes("1 line(s)"));
const grepNum = text(await client.callTool({ name: "sh_detail", arguments: { id: big.id, selector: "stdout", match: "^150$" } }));
check("sh_detail match finds mid-stream value with line number", grepNum.includes("L150: 150"));
const grepBad = JSON.parse(text(await client.callTool({ name: "sh_detail", arguments: { id: big.id, selector: "stdout", match: "(" } })));
check("sh_detail match invalid regex errors", typeof grepBad.error === "string" && grepBad.error.includes("invalid regex"));

// ── 21c) interactive command gets a Bash advisory (mitigation C) ──
const manRun = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "man" } })));
check("interactive command advises raw Bash", typeof manRun.advice === "string" && manRun.advice.includes("interactive"));

// ── 21d) structured trace (feature A) — best-effort everywhere, real capture on Linux ──
const traceRun = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo hi", trace: true } })));
check("trace best-effort: runs; flags unavailable off Linux", traceRun.ok === true && (process.platform === "linux" || traceRun.trace_unavailable === true));
if (process.platform === "linux" && traceAvailable()) {
  const tdir = mkdtempSync(join(tmpdir(), "veil-tracetest-"));
  const t = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo data > out.txt", cwd: tdir, trace: true } })));
  check("trace captures the written path (Linux)", !!t.trace_summary && t.trace_summary.wrote.some((p: string) => p.includes("out.txt")));
  check("files_changed derived from trace, no git (Linux)", Array.isArray(t.files_changed) && t.files_changed.some((l: string) => l.includes("out.txt")));
  const traceFull = text(await client.callTool({ name: "sh_detail", arguments: { id: t.id, selector: "trace" } }));
  check("sh_detail trace returns the raw trace (Linux)", typeof traceFull === "string" && traceFull.includes("open"));
  rmSync(tdir, { recursive: true, force: true });
}

// ── 22) snapshot error / security paths (traversal label, missing label/dir, dir-guard) ──
const snapA = mkdtempSync(join(tmpdir(), "veil-snapA-"));
const snapB = mkdtempSync(join(tmpdir(), "veil-snapB-"));
const badLabel = JSON.parse(text(await client.callTool({ name: "sh_checkpoint", arguments: { label: "../escape", dir: snapA } })));
check("checkpoint rejects traversal label", typeof badLabel.error === "string" && badLabel.error.includes("invalid checkpoint label"));
// bare ".."/"." must be rejected BEFORE the "fresh snapshot" rmSync: dest=join(STORE,"..")
// resolves to the temp root, which would otherwise be recursively force-deleted.
for (const lbl of ["..", "."]) {
  const before = existsSync(tmpdir());
  const esc = JSON.parse(text(await client.callTool({ name: "sh_checkpoint", arguments: { label: lbl, dir: snapA } })));
  check(`checkpoint rejects ${JSON.stringify(lbl)} label`, typeof esc.error === "string" && (esc.error.includes("invalid checkpoint label") || esc.error.includes("escapes store")));
  check(`checkpoint ${JSON.stringify(lbl)} does not wipe tmpdir`, before && existsSync(tmpdir()));
}
// a multi-dot label is a harmless literal dir name — must still be accepted.
const okMulti = JSON.parse(text(await client.callTool({ name: "sh_checkpoint", arguments: { label: "ok...dir-1", dir: snapA } })));
check("checkpoint accepts multi-dot label", okMulti.checkpointed === "ok...dir-1");
const missRestore = JSON.parse(text(await client.callTool({ name: "sh_restore", arguments: { label: "never-made-xyz", dir: snapA } })));
check("restore unknown label errors", typeof missRestore.error === "string" && missRestore.error.includes("no checkpoint named"));
const missDir = JSON.parse(text(await client.callTool({ name: "sh_checkpoint", arguments: { label: "okdir", dir: "/no/such/dir/zzz" } })));
check("checkpoint missing dir errors", typeof missDir.error === "string" && missDir.error.includes("dir does not exist"));
await client.callTool({ name: "sh_checkpoint", arguments: { label: "guardtest", dir: snapA } });
const wrongDir = JSON.parse(text(await client.callTool({ name: "sh_restore", arguments: { label: "guardtest", dir: snapB } })));
check("restore refuses mismatched target dir", typeof wrongDir.error === "string" && wrongDir.error.includes("refusing to restore"));
rmSync(snapA, { recursive: true, force: true });
rmSync(snapB, { recursive: true, force: true });

// ── 22b) sandbox (K) — real kernel write-confinement (macOS) ──
if (process.platform === "darwin" && sandboxAvailable()) {
  const sbxRoot = join(homedir(), `.veil-sbx-${process.pid}`);
  const sbxWork = join(sbxRoot, "work");
  mkdirSync(sbxWork, { recursive: true });
  const escaped = join(sbxRoot, "escaped.txt"); // parent of cwd → outside the allowed subpath
  // precondition: the escape target really is outside every writable root.
  check("sandbox escape target is outside writable roots", !escaped.startsWith(realpathSync(sbxWork)) && !escaped.startsWith(realpathSync(tmpdir())));
  // ONE run proving SELECTIVE enforcement: inside write lands, outside write blocked.
  const sel = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: `echo IN > inside.txt; echo OUT > ${escaped} 2>/dev/null; cat inside.txt`, cwd: sbxWork, sandbox: true } })));
  check("sandbox writes inside cwd, blocks outside (selective)", sel.sandboxed === true && sel.stdout.includes("IN") && existsSync(join(sbxWork, "inside.txt")) && !existsSync(escaped));
  // a pure outside write fails non-zero.
  const outDenied = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: `echo bad > ${escaped}`, cwd: sbxWork, sandbox: true } })));
  check("sandbox pure outside-write fails", outDenied.ok === false && outDenied.sandboxed === true && !existsSync(escaped));
  check("sandbox denial gives actionable advice", typeof outDenied.advice === "string" && outDenied.advice.includes("writable"));
  // DEV_WRITES provisioning guard: /dev/null + /dev/urandom must still work.
  const dev = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo x > /dev/null && head -c1 /dev/urandom > /dev/null && echo DEVOK", cwd: sbxWork, sandbox: true } })));
  check("sandbox allows /dev/null + /dev/urandom", dev.ok === true && dev.stdout.includes("DEVOK"));
  // network: connect to a closed loopback port. deny → EPERM ("Operation not permitted"); allow → ECONNREFUSED.
  const netDeny = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "exec 3<>/dev/tcp/127.0.0.1/9", cwd: sbxWork, sandbox: { network: false } } })));
  check("sandbox network:false blocks connect (EPERM)", netDeny.ok === false && /not permitted/i.test(String(netDeny.stderr ?? "")));
  const netAllow = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "exec 3<>/dev/tcp/127.0.0.1/9", cwd: sbxWork, sandbox: true } })));
  check("sandbox network allowed is not EPERM", !/not permitted/i.test(String(netAllow.stderr ?? "")));
  // timeout must reap the sandboxed child via the process-group kill.
  const sbxTimeout = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "sleep 30", cwd: sbxWork, sandbox: true, timeout_ms: 600 } })));
  check("timeout reaps sandboxed child", sbxTimeout.timed_out === true && sbxTimeout.exit === 124 && sbxTimeout.sandboxed === true);
  // unsafe writable path → validation error, never a run.
  const badPath = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo x", cwd: sbxWork, sandbox: { writable: ["/x'quote"] } } })));
  check("sandbox unsafe writable path refused (no run)", typeof badPath.error === "string" && badPath.error.includes("unsafe path") && badPath.sandboxed !== true && !("ok" in badPath));
  // #3: a destructive command that IS sandboxed should not get the "unconfined" advice.
  await client.callTool({ name: "sh_run", arguments: { command: "echo x > t.txt", cwd: sbxWork, sandbox: true } });
  const sbxRm = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "rm t.txt", cwd: sbxWork, sandbox: true } })));
  check("sandboxed destructive gets no advice", sbxRm.sandboxed === true && !("advice" in sbxRm));
  rmSync(sbxRoot, { recursive: true, force: true });
} else if (process.platform === "linux" && sandboxAvailable()) {
  // Linux bubblewrap write-confinement (validated in CI). Conservative assertions —
  // no error-wording dependence, since bwrap semantics differ from sandbox-exec.
  // Root under HOME, NOT tmpdir: the temp dir is always a writable root (bwrap binds
  // it rw), so an escape target under /tmp would be writable and the deny would fail.
  const lroot = join(homedir(), `.veil-lsbx-${process.pid}`);
  const lwork = join(lroot, "work");
  mkdirSync(lwork, { recursive: true });
  const lescaped = join(lroot, "escaped.txt"); // under HOME (ro-bound), outside every writable root
  check("bwrap escape target outside writable roots (Linux)", !lescaped.startsWith(realpathSync(lwork)) && !lescaped.startsWith(realpathSync(tmpdir())));
  const lin = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo hi > inside.txt", cwd: lwork, sandbox: true } })));
  check("bwrap allows write inside cwd (Linux)", lin.ok === true && lin.sandboxed === true && existsSync(join(lwork, "inside.txt")));
  const lout = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: `echo bad > ${lescaped}`, cwd: lwork, sandbox: true } })));
  check("bwrap blocks write outside cwd (Linux)", lout.ok === false && lout.sandboxed === true && !existsSync(lescaped));
  rmSync(lroot, { recursive: true, force: true });
} else {
  // No sandbox available (e.g. Linux without bwrap): a request must REFUSE.
  const unavail = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo x", sandbox: true } })));
  check("sandbox unavailable refuses to run", unavail.sandbox_unavailable === true);
}

await client.close();

// ── 23) truncation honesty + binary handling — fresh server, tiny byte cap ──
const truncTransport = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: { ...process.env, VEIL_MAX_STREAM_BYTES: "2000" } });
const truncClient = new Client({ name: "smoke-trunc", version: "0.0.0" });
await truncClient.connect(truncTransport);
const tr = JSON.parse(text(await truncClient.callTool({ name: "sh_run", arguments: { command: "seq 1 100000" } })));
check("truncation sets stdout_truncated", tr.stdout_truncated === true);
check("truncated stdout_lines is TRUE emitted count (100000)", tr.stdout_lines === 100000);
// The first content line must be a high tail number, NOT the dropped stream start ("1").
const firstContent = tr.stdout.split("\n").find((l: string) => l && !l.includes("truncated at byte cap"));
check("truncated stdout marks byte cap + shows tail not start", tr.stdout.includes("truncated at byte cap") && /^\d{4,}$/.test(firstContent ?? ""));
const trMeta = JSON.parse(text(await truncClient.callTool({ name: "sh_detail", arguments: { id: tr.id, selector: "meta" } })));
check("sh_detail meta reports stdout_truncated", trMeta.stdout_truncated === true);
const trStdout = text(await truncClient.callTool({ name: "sh_detail", arguments: { id: tr.id, selector: "stdout" } }));
check("sh_detail banners the truncated tail", trStdout.startsWith("[truncated"));
const bin = JSON.parse(text(await truncClient.callTool({ name: "sh_run", arguments: { command: "head -c 100 /dev/zero" } })));
check("binary stdout flagged, not inlined", bin.stdout_binary === true && !("stdout" in bin));
check("binary omits meaningless line count", !("stdout_lines" in bin));
// Lossless round-trip: sh_detail returns base64 (no banner — 100B is under the cap), decodes to the real bytes.
const rawB64 = text(await truncClient.callTool({ name: "sh_detail", arguments: { id: bin.id, selector: "stdout" } }));
const decoded = Buffer.from(rawB64, "base64");
check("binary stream recoverable as 100 NUL bytes", decoded.length === 100 && decoded.every((b) => b === 0));
const binMeta = JSON.parse(text(await truncClient.callTool({ name: "sh_detail", arguments: { id: bin.id, selector: "meta" } })));
check("meta mirrors stdout_binary", binMeta.stdout_binary === true);
await truncClient.close();

// ── 24) store eviction at capacity — fresh server, VEIL_MAX_RECORDS=3, isolated dir ──
const evDir = mkdtempSync(join(tmpdir(), "veil-evict-"));
const evT = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: { ...process.env, VEIL_MAX_RECORDS: "3", VEIL_STATE_DIR: evDir } });
const evC = new Client({ name: "smoke-evict", version: "0.0.0" });
await evC.connect(evT);
let firstId = "";
let lastId = "";
for (let i = 0; i < 4; i++) {
  const r = JSON.parse(text(await evC.callTool({ name: "sh_run", arguments: { command: `echo run${i}` } })));
  if (i === 0) firstId = r.id;
  lastId = r.id;
}
const evicted = JSON.parse(text(await evC.callTool({ name: "sh_detail", arguments: { id: firstId, selector: "stdout" } })));
check("oldest record evicted at capacity", typeof evicted.error === "string" && evicted.error.includes("unknown id"));
const kept = text(await evC.callTool({ name: "sh_detail", arguments: { id: lastId, selector: "stdout" } }));
check("newest record still addressable", kept.includes("run3"));
await evC.close();
rmSync(evDir, { recursive: true, force: true });

// ── 24b) record store survives a server restart — disk-backed (mitigation #6) ──
const persistDir = mkdtempSync(join(tmpdir(), "veil-persist-"));
const persistEnv = { ...process.env, VEIL_STATE_DIR: persistDir };
const psT1 = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: persistEnv });
const psC1 = new Client({ name: "smoke-persist1", version: "0.0.0" });
await psC1.connect(psT1);
const ps1 = JSON.parse(text(await psC1.callTool({ name: "sh_run", arguments: { command: "echo PERSIST_ME" } })));
await psC1.close(); // first server process exits — memory is gone, disk remains
// Fresh server, SAME state dir + cwd → must recover the earlier run.
const psT2 = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: persistEnv });
const psC2 = new Client({ name: "smoke-persist2", version: "0.0.0" });
await psC2.connect(psT2);
const recovered = text(await psC2.callTool({ name: "sh_detail", arguments: { id: ps1.id, selector: "stdout" } }));
check("sh_detail recovers a run after a server restart (disk-backed store)", recovered.includes("PERSIST_ME"));
const ps2 = JSON.parse(text(await psC2.callTool({ name: "sh_run", arguments: { command: "echo SECOND" } })));
check("restarted server continues ids past the recovered counter (no collision)", Number(ps2.id.slice(3)) > Number(ps1.id.slice(3)));
await psC2.close();
rmSync(persistDir, { recursive: true, force: true });

// ── 25) VEIL_EFFECTS=0 disables the effect-diff, but a `changed` assert still forces it (mitigation D) ──
const noFxT = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: { ...process.env, VEIL_EFFECTS: "0" } });
const noFxC = new Client({ name: "smoke-nofx", version: "0.0.0" });
await noFxC.connect(noFxT);
const fxRepo = mkdtempSync(join(tmpdir(), "veil-nofx-"));
execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: fxRepo, shell: "/bin/bash" });
writeFileSync(join(fxRepo, "a.txt"), "base\n");
execSync("git add -A && git commit -qm init", { cwd: fxRepo, shell: "/bin/bash" });
const noFx = JSON.parse(text(await noFxC.callTool({ name: "sh_run", arguments: { command: "echo more >> a.txt", cwd: fxRepo } })));
check("VEIL_EFFECTS=0 skips effect-diff", !("files_changed" in noFx));
const noFxForced = JSON.parse(text(await noFxC.callTool({ name: "sh_run", arguments: { command: "echo new > b.txt", cwd: fxRepo, expect: { changed: true } } })));
check("changed assertion still forces effect-diff when effects off", noFxForced.assert_ok === true);
rmSync(fxRepo, { recursive: true, force: true });
await noFxC.close();

rmSync(STATE_BASE, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
