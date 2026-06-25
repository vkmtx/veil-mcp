/**
 * End-to-end smoke test: boot the server over stdio, exercise both tools, assert
 * the contract. Exits non-zero on any failed assertion.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, statSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { condense, lineCount } from "../src/render.js";
import { extractSignals } from "../src/signals.js";
import { diffStatus, effectsFromTrace } from "../src/effects.js";
import { sandboxAvailable, buildProfile, buildBwrapArgs, buildLandrunArgs, defaultSecretPaths, scrubSecretEnv } from "../src/policy.js";
import { looksInteractive, classify } from "../src/classify.js";
import { traceAvailable, buildTraceCommand, summarizeTrace } from "../src/trace.js";
import { runInit } from "../src/init.js";
import { chooseMethod, checkpoint, restore, list } from "../src/snapshot.js";
import { CLASSIFY_CORPUS } from "./classify-corpus.js";
import { runCommand } from "../src/exec.js";
import { shQuote } from "../src/shquote.js";
import { resolveBin } from "../src/binpath.js";
import { TURNS, recallCorpus, recallSurfaced } from "../bench/metrics-data.js";
import { config } from "../src/config.js";

// Isolate the on-disk record store for the whole test: child servers inherit this
// env, so they never touch the real ~/.local/state/veil. Cleaned up at exit.
const STATE_BASE = mkdtempSync(join(tmpdir(), "veil-smoke-state-"));
process.env.VEIL_STATE_DIR = STATE_BASE;

let failures = 0;
let total = 0;
function check(name: string, cond: boolean): void {
  total++;
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

// K++ Landlock backend (landrun) — namespace-free; pure arg-builder, verifiable anywhere.
const lr = buildLandrunArgs("echo hi", "/tmp/work", {});
check("landrun grants rox / + rwx cwd + runs via sh", lr.includes("--rox /") && lr.includes("--rwx") && lr.includes("/tmp/work") && lr.includes("-- /bin/sh -c"));
check("landrun grants writable /dev", lr.includes("--rwx /dev"));
// honesty: a knob Landlock can't enforce makes the builder THROW (caller then refuses),
// never silently run without it.
let lrNet = false;
try { buildLandrunArgs("x", "/tmp/w", { network: false }); } catch { lrNet = true; }
check("landrun refuses network-deny (refuse, don't fake)", lrNet);
let lrRead = false;
try { buildLandrunArgs("x", "/tmp/w", { denyRead: ["/home/u/.ssh"] }); } catch { lrRead = true; }
check("landrun refuses secret read-confine (allow-list model)", lrRead);

// feature A — trace summarizer (the testable core) + platform detection.
check("traceAvailable false off Linux", process.platform === "linux" || traceAvailable() === false);
check("buildTraceCommand null when no tracer", process.platform === "linux" || buildTraceCommand("echo x", "/tmp/t") === null);
const trSum = summarizeTrace('openat(AT_FDCWD, "/etc/hosts", O_RDONLY) = 3\nopenat(AT_FDCWD, "/tmp/out.txt", O_WRONLY|O_CREAT, 0644) = 4\nstat("/x") = 0');
check("summarizeTrace splits reads vs writes", trSum.wrote.includes("/tmp/out.txt") && trSum.read.includes("/etc/hosts") && trSum.syscalls === 3);
// strace -f interrupted syscalls print "<unfinished ...>"; the flags precede it, so writes aren't lost.
const trUnfin = summarizeTrace('[pid 9] openat(AT_FDCWD, "/tmp/u.txt", O_WRONLY|O_CREAT <unfinished ...>');
check("summarizeTrace catches unfinished write line", trUnfin.wrote.includes("/tmp/u.txt"));
// OGL-95: deletions (unlink/rmdir) and rename (source deleted, dest written) are summarized,
// alongside the openat-write — only when the syscall SUCCEEDED (`= 0`).
const trDel = summarizeTrace(
  'unlink("/tmp/gone.txt")                  = 0\n' +
  'rename("/tmp/old.txt", "/tmp/new.txt")   = 0\n' +
  'openat(AT_FDCWD, "/tmp/w.txt", O_WRONLY|O_CREAT, 0644) = 5',
);
check("summarizeTrace records unlink + rename source as deleted", trDel.deleted.includes("/tmp/gone.txt") && trDel.deleted.includes("/tmp/old.txt"));
check("summarizeTrace records rename dest + openat-write as wrote", trDel.wrote.includes("/tmp/new.txt") && trDel.wrote.includes("/tmp/w.txt"));
// honesty: a FAILED unlink (`= -1 ENOENT`) deleted nothing and must not be counted.
const trFail = summarizeTrace('unlink("/tmp/missing.txt")               = -1 ENOENT (No such file or directory)');
check("summarizeTrace ignores a failed unlink (= -1 ENOENT)", !trFail.deleted.includes("/tmp/missing.txt") && trFail.deleted.length === 0);
// effects-from-trace: cwd-scoped writes become files_changed (replaces git when tracing).
const fxTrace = effectsFromTrace(["/work/a.txt", "/work/sub/b.txt", "/etc/passwd", "/work/a.txt"], [], "/work");
check("effectsFromTrace scopes to cwd, relativizes, dedupes", fxTrace.includes("wrote a.txt") && fxTrace.includes("wrote sub/b.txt") && !fxTrace.some((l) => l.includes("passwd")) && fxTrace.length === 2);
// OGL-95: deletions are emitted as "deleted <rel>" lines, cwd-scoped like writes —
// an out-of-cwd removal is dropped, and a write+delete of the same path keeps both.
const fxDel = effectsFromTrace(["/work/keep.txt"], ["/work/gone.txt", "/etc/shadow", "/work/keep.txt"], "/work");
check("effectsFromTrace emits cwd-scoped deleted lines", fxDel.includes("wrote keep.txt") && fxDel.includes("deleted gone.txt") && fxDel.includes("deleted keep.txt") && !fxDel.some((l) => l.includes("shadow")));
// effectsFromTrace canonicalizes cwd: strace records the REAL path, so a symlinked
// root must still match (else in-cwd writes are silently dropped from files_changed).
const realDir = realpathSync(mkdtempSync(join(tmpdir(), "veil-fxreal-")));
const linkDir = join(tmpdir(), `veil-fxlink-${process.pid}`);
rmSync(linkDir, { force: true });
symlinkSync(realDir, linkDir);
const fxSym = effectsFromTrace([join(realDir, "c.txt")], [], linkDir); // cwd given via the symlink
check("effectsFromTrace matches through a symlinked cwd", fxSym.includes("wrote c.txt"));
rmSync(linkDir, { force: true });
rmSync(realDir, { recursive: true, force: true });

// snapshot method honesty: "clone" (CoW) is claimed ONLY within one volume, so a
// cross-device cp -cR full-copy is never mislabeled as an instant clone.
check("snapshot clones only within one volume (darwin, same dev)", chooseMethod("darwin", 42, 42) === "clone");
check("snapshot cross-volume reports rsync, not a mislabeled clone", chooseMethod("darwin", 42, 43) === "rsync");
check("snapshot non-darwin always rsync", chooseMethod("linux", 42, 42) === "rsync");
check("snapshot unstattable source never clones", chooseMethod("darwin", -1, -1) === "rsync");

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
// git clean force-delete is DESTRUCTIVE whether force is a bundled short cluster
// or the long --force (the latter previously misread as read-only).
check("classify git clean --force destructive", classify("git clean --force").category === "destructive");
check("classify git clean -d --force destructive", classify("git clean -d --force").category === "destructive");
check("classify git clean -fdx destructive", classify("git clean -fdx").category === "destructive");
check("classify git clean -n stays read-only (dry-run)", classify("git clean -n").category === "read-only");
// A glob/redirect/$() must never DOWNGRADE a known-destructive verb to "complex"
// (rank 0): the atom classifier re-runs on the whole unanalyzable command.
check("classify rm glob not downgraded", classify("rm *").category === "destructive");
check("classify shred with redirect destructive", classify("shred -u f > /dev/null").category === "destructive");
check("classify git reset --hard via $() destructive", classify("git reset --hard $(git rev-parse HEAD~3)").category === "destructive");
// ...but a NON-destructive command with a glob stays honestly complex (no over-flag).
check("classify grep glob stays complex", classify("grep x *.log").category === "complex");
// quoted git subcommand must classify like the bare form (review #2).
check("classify quoted git reset --hard destructive", classify('git "reset" --hard').category === "destructive");
check("classify quoted git clean -fd destructive", classify("git 'clean' -fd").category === "destructive");
check("classify quoted git push --force destructive", classify('git "push" --force').category === "destructive");

// ── veil-guard hook: bypass anchoring + danger coverage ─────────────────────────
const guardPath = new URL("../hooks/veil-guard.sh", import.meta.url).pathname;
function guardExit(command: string): number {
  try {
    execSync(`/bin/sh '${guardPath}'`, { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), stdio: ["pipe", "pipe", "pipe"] });
    return 0;
  } catch (e: any) {
    return typeof e.status === "number" ? e.status : -1;
  }
}
// Self-gate: the hook needs an interpreter to parse stdin; without it it fails
// open (exit 0). Assert blocking only where the hook is functional, so a runner
// missing /usr/bin/python3 doesn't red the suite.
if (guardExit("rm -rf /tmp/__veil_probe") === 2) {
  // A trailing comment must NOT fake a bypass — VEIL_BYPASS is a LEADING env-assign only.
  check("guard: comment cannot fake VEIL_BYPASS", guardExit("rm -rf / # VEIL_BYPASS=1") === 2);
  // ...and the real, leading escape hatch still works.
  check("guard: leading VEIL_BYPASS=1 allows raw Bash", guardExit("VEIL_BYPASS=1 vim x") === 0 && guardExit("VEIL_BYPASS=1 rm -rf /tmp/x") === 0);
  // Danger forms the old single-regex missed.
  for (const cmd of ["find . -name x -delete", "git clean -fdx", "git clean --force", "chmod -R 777 /", "shred -u f", "truncate -s 0 db", "rm --recursive --force /data"]) {
    check(`guard: blocks ${cmd}`, guardExit(cmd) === 2);
  }
  // Must NOT over-block benign forms — incl. shred/truncate as an ARGUMENT or
  // filename (anchored to command position), and a post-operator command position
  // must still block.
  check("guard: allows non-recursive chmod + git status", guardExit("chmod 755 f") === 0 && guardExit("git status") === 0);
  for (const cmd of ["cat shred.log", "grep -r truncate src/", "psql -c 'truncate table t'"]) {
    check(`guard: allows benign ${cmd}`, guardExit(cmd) === 0);
  }
  check("guard: still blocks shred/truncate after an operator", guardExit("echo x | shred f") === 2 && guardExit("a && truncate -s 0 db") === 2);
  // Verbose installs/builds/tests are routed to sh_run — incl. modern tools the old
  // list missed (bun/deno/uv) and image builds (docker build / compose build).
  for (const cmd of ["npm install", "pytest -q", "cargo build", "bun install", "bun add zod", "deno test", "uv pip install ruff", "uv sync", "docker build -t x .", "docker compose build", "docker-compose build"]) {
    check(`guard: blocks verbose ${cmd}`, guardExit(cmd) === 2);
  }
  // ...but read-only (`docker ps|logs`) and dev-server forms (`run dev/start`, `--watch`)
  // of the very same tools must still pass through to raw Bash.
  for (const cmd of ["docker ps", "docker logs app", "bun run dev", "npm run start", "deno run --watch x"]) {
    check(`guard: allows passthrough ${cmd}`, guardExit(cmd) === 0);
  }
} else {
  check("guard: SKIPPED (hook not functional in this environment)", true);
}

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
// review #9 (data loss): an orphan start marker BEFORE a complete block must NOT
// let an in-place replace span across and delete the user content between them.
const initDir4 = mkdtempSync(join(tmpdir(), "veil-init4-"));
writeFileSync(join(initDir4, "CLAUDE.md"), `<!-- veil-mcp:start -->\nKEEP THIS USER LINE\n<!-- veil-mcp:start -->\n## veil-mcp\nbody\n<!-- veil-mcp:end -->\n`);
runInit(initDir4);
check("veil init never deletes content between mismatched markers", readFileSync(join(initDir4, "CLAUDE.md"), "utf8").includes("KEEP THIS USER LINE"));
rmSync(initDir, { recursive: true, force: true });
rmSync(initDir2, { recursive: true, force: true });
rmSync(initDir3, { recursive: true, force: true });
rmSync(initDir4, { recursive: true, force: true });
const prof = buildProfile("/tmp/xcwd", {});
check("profile confines writes and re-allows cwd", prof.includes("(deny file-write*)") && prof.includes("/tmp/xcwd"));
check("profile denies network only when asked", buildProfile("/tmp/x", { network: false }).includes("(deny network*)") && !buildProfile("/tmp/x", {}).includes("(deny network*)"));
let profThrew = false;
try { buildProfile("/tmp/x", { writable: ["/bad'quote"] }); } catch { profThrew = true; }
check("profile rejects single-quote path", profThrew);
let dqThrew = false;
try { buildProfile("/tmp/x", { writable: ['/bad"q'] }); } catch { dqThrew = true; }
check("profile rejects double-quote path", dqThrew);

// read-confine (Idea 2 — secret-path denylist): profile/arg shape + defaults.
const profRC = buildProfile("/tmp/x", { denyRead: ["/home/u/.ssh", "/home/u/.aws"] });
check("profile denies reads of secret subpaths", profRC.includes("(deny file-read*") && profRC.includes("/home/u/.ssh") && profRC.includes("/home/u/.aws"));
check("profile omits read-deny when none requested", !buildProfile("/tmp/x", {}).includes("(deny file-read*"));
const bwRC = buildBwrapArgs("echo x", "/tmp/w", { denyRead: ["/home/u/.ssh"] });
check("bwrap masks secret dir with tmpfs", bwRC.includes("--tmpfs") && bwRC.includes("/home/u/.ssh"));
check("bwrap omits tmpfs when no secrets", !buildBwrapArgs("echo x", "/tmp/w", {}).includes("--tmpfs"));
let rcThrew = false;
try { buildProfile("/tmp/x", { denyRead: ["/bad'quote"] }); } catch { rcThrew = true; }
check("profile rejects unsafe denyRead path", rcThrew);
check("defaultSecretPaths includes ssh + aws dirs", defaultSecretPaths().some((p) => p.endsWith("/.ssh")) && defaultSecretPaths().some((p) => p.endsWith("/.aws")));

// OGL-98 — scrubSecretEnv drops credential-shaped names, keeps infra vars, and
// HONESTLY lists exactly what it removed (sorted) so the count can be disclosed.
const scrub = scrubSecretEnv({ PATH: "/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "x", GITHUB_TOKEN: "y", MY_API_KEY: "z", FOO: "keep", LANG: "C" });
check("scrubSecretEnv keeps infra + non-secret vars", scrub.env.PATH === "/bin" && scrub.env.HOME === "/h" && scrub.env.FOO === "keep" && scrub.env.LANG === "C");
check("scrubSecretEnv drops credential-shaped names", !("AWS_SECRET_ACCESS_KEY" in scrub.env) && !("GITHUB_TOKEN" in scrub.env) && !("MY_API_KEY" in scrub.env));
check("scrubSecretEnv reports exactly the dropped names, sorted", JSON.stringify(scrub.scrubbed) === JSON.stringify(["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "MY_API_KEY"]));

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

// ── value metrics (deterministic): the published recall + turns-saved numbers ───
// Same corpus bench/metrics.ts prints, asserted here so the figures can't drift.
check("signal recall is 100% on the labeled corpus (every buried failure surfaces)", recallCorpus.every((c) => recallSurfaced(c, condense)));
check("turns-saved: every task needs fewer veil calls than raw", TURNS.every((t) => t.veil < t.raw));
check("turns-saved: 11 raw -> 5 veil calls across the corpus", TURNS.reduce((a, t) => a + t.raw, 0) === 11 && TURNS.reduce((a, t) => a + t.veil, 0) === 5);

// truncation honesty: marker present, torn first fragment dropped.
const truncRendered = condense("torn-fragment-line\nreal line A\nreal line B", "u9", "stdout", { truncated: true });
check("condense marks truncation and drops torn fragment", truncRendered.includes("truncated at byte cap") && !truncRendered.includes("torn-fragment-line"));

const serverEntry = new URL("../src/index.ts", import.meta.url).pathname;
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry] });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
check("lists sh_run + sh_detail", tools.includes("sh_run") && tools.includes("sh_detail"));
check("lists sh_history", tools.includes("sh_history"));
// VER-1: the version advertised over the MCP handshake must equal package.json (not a
// hardcoded literal that drifts). server.ts derives it via createRequire.
const pkgVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
check("server handshake version == package.json", client.getServerVersion()?.version === pkgVersion);

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

// 5c) on timeout we SIGTERM then escalate to SIGKILL after 2s, holding that
// escalation timer so finish() can cancel it once the child exits. A child that
// exits promptly on SIGTERM must settle WITHOUT waiting the 2s hard-kill window.
// (The stray-SIGKILL-to-a-recycled-pgid negative isn't observable in-process, so we
// assert the prompt-settle path that contains the timer-clear instead.)
const graceful = await runCommand("trap 'exit 0' TERM; sleep 10", process.cwd(), 300);
check("SIGTERM-graceful run settles without the 2s hard-kill wait", graceful.timedOut === true && graceful.durationMs < 1500);

// 6) effect diff in a real git repo
const repo = mkdtempSync(join(tmpdir(), "veil-"));
execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: repo, shell: "/bin/bash" });
writeFileSync(join(repo, "a.txt"), "base\n");
execSync("git add -A && git commit -qm init", { cwd: repo, shell: "/bin/bash" });
const e = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo new > b.txt && echo more >> a.txt", cwd: repo } })));
check("effect diff lists modified + new", Array.isArray(e.files_changed) && e.files_changed.some((l: string) => l.includes("a.txt")) && e.files_changed.some((l: string) => l.includes("b.txt")));
// OGL-102: the gitStatus-backed effects path still reports a non-empty changeset
// after switching `git status` to execFileSync (maxBuffer raised, no shell hop).
check("gitStatus-backed files_changed non-empty after execFileSync switch", Array.isArray(e.files_changed) && e.files_changed.length > 0);
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
const cl = JSON.parse(text(await client.callTool({ name: "sh_checkpoints", arguments: { dir: ckptDir } })));
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
writeFileSync(join(snapB, "snapB-marker.txt"), "do not wipe\n");
await client.callTool({ name: "sh_checkpoint", arguments: { label: "guardtest", dir: snapA } });
const wrongDir = JSON.parse(text(await client.callTool({ name: "sh_restore", arguments: { label: "guardtest", dir: snapB } })));
// Checkpoints are namespaced per source dir, so one taken in snapA is unaddressable
// from snapB — restore fails safely with "no checkpoint named" (the origin-sidecar
// "refusing to restore" guard stays as defense-in-depth). Either way, the mismatched
// target must NOT be wiped by rsync --delete.
check("restore into a mismatched dir fails safely", typeof wrongDir.error === "string" && (wrongDir.error.includes("no checkpoint named") || wrongDir.error.includes("refusing to restore")));
check("mismatched-dir restore does not wipe the target", existsSync(join(snapB, "snapB-marker.txt")));
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

// ── 22c) read-confine (Idea 2) — block reads of a configured secret-path list ──
if (sandboxAvailable()) {
  const secretDir = mkdtempSync(join(tmpdir(), "veil-secret-"));
  writeFileSync(join(secretDir, "id_rsa"), "TOPSECRETKEY\n");
  const rcWork = mkdtempSync(join(tmpdir(), "veil-rcwork-"));
  // The secret read is DENIED when the dir is on the deny_read list…
  const blocked = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: `cat ${join(secretDir, "id_rsa")}`, cwd: rcWork, sandbox: { deny_read: [secretDir] } } })));
  check("read-confine blocks the secret read", blocked.ok === false && !String(blocked.stdout ?? "").includes("TOPSECRETKEY") && blocked.secrets_protected === 1);
  // …but the SAME read succeeds under a plain write-confine sandbox — proving the
  // denial is caused by deny_read, not by the sandbox itself.
  const allowed = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: `cat ${join(secretDir, "id_rsa")}`, cwd: rcWork, sandbox: true } })));
  check("plain sandbox still reads it (deny_read is the cause)", allowed.ok === true && String(allowed.stdout ?? "").includes("TOPSECRETKEY"));
  // SECRET-DROP-1: a requested secret that exists as a FILE can't be masked by the
  // dir-only backend — it must be DISCLOSED in secrets_unprotected, never silently
  // dropped while secrets_protected counts only the dir.
  const fileSecret = join(secretDir, "id_rsa"); // a FILE
  const drop = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "true", cwd: rcWork, sandbox: { deny_read: [fileSecret, secretDir] } } })));
  check("file-secret disclosed as unprotected (not silently dropped)", drop.secrets_protected === 1 && Array.isArray(drop.secrets_unprotected) && drop.secrets_unprotected.some((p: string) => p.includes("id_rsa")));
  rmSync(secretDir, { recursive: true, force: true });
  rmSync(rcWork, { recursive: true, force: true });
}

// ── 22c-bis) ASSERT honesty — content checks vs binary (base64) + truncated streams ──
// Binary: stdout with a NUL is stored base64; stdout_contains must decode, not FAIL.
const binAssert = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "printf 'abc\\000xyz'", expect: { stdout_contains: "abc" } } })));
check("stdout_contains decodes binary (no confident-wrong fail)", binAssert.stdout_binary === true && binAssert.assert_ok === true);

// ── 22d) dry-run preview (Idea 1) — runs in a clone, real cwd untouched ──
const pvDir = mkdtempSync(join(tmpdir(), "veil-preview-"));
writeFileSync(join(pvDir, "keep.txt"), "original\n");
writeFileSync(join(pvDir, "a and b.txt"), "v1\n"); // name contains " and " — exercises the differ parse
const pv = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: 'echo NEW > added.txt && rm keep.txt && echo more >> "a and b.txt"', cwd: pvDir, preview: true } })));
check("preview flagged + warns it is not a sandbox", pv.preview === true && typeof pv.preview_warning === "string" && pv.preview_warning.includes("not a sandbox"));
check("preview reports cwd-relative created + deleted", Array.isArray(pv.files_changed) && pv.files_changed.some((l: string) => l.includes("created") && l.includes("added.txt")) && pv.files_changed.some((l: string) => l.includes("deleted") && l.includes("keep.txt")));
check("preview parses modified file whose name contains ' and '", pv.files_changed.some((l: string) => l === "modified a and b.txt"));
check("preview leaves the REAL cwd untouched", existsSync(join(pvDir, "keep.txt")) && !existsSync(join(pvDir, "added.txt")) && readFileSync(join(pvDir, "a and b.txt"), "utf8") === "v1\n");
check("preview command actually ran (real exit)", pv.ok === true);
rmSync(pvDir, { recursive: true, force: true });
// refuse (never run in real cwd) when the dir cannot be cloned.
const pvBad = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo x", cwd: "/no/such/preview/dir/zzz", preview: true } })));
check("preview refuses when cwd cannot be cloned", pvBad.preview_unavailable === true && !("ok" in pvBad));
check("preview reports its clone method", pv.preview_method === "clone" || pv.preview_method === "rsync");

// ── 22e) preview + sandbox compose: command runs in the clone, confined, real cwd untouched ──
if (sandboxAvailable()) {
  const psDir = mkdtempSync(join(tmpdir(), "veil-prevsbx-"));
  writeFileSync(join(psDir, "seed.txt"), "x\n");
  const ps = JSON.parse(text(await client.callTool({ name: "sh_run", arguments: { command: "echo made > out.txt", cwd: psDir, preview: true, sandbox: true } })));
  check("preview+sandbox: both flags surface, real cwd untouched", ps.preview === true && ps.sandboxed === true && ps.ok === true && !existsSync(join(psDir, "out.txt")));
  rmSync(psDir, { recursive: true, force: true });
}

await client.close();

// ── 22c) store permissions: persisted records are OWNER-ONLY (no secret leak on
// a shared host). The main server above wrote records under STATE_BASE/proj-*. ──
if (process.platform !== "win32") {
  const projDir = readdirSync(STATE_BASE).filter((f) => f.startsWith("proj-")).map((f) => join(STATE_BASE, f))[0];
  const recFile = projDir ? readdirSync(projDir).find((f) => /^cmd\d+\.json$/.test(f)) : undefined;
  check("store dir is owner-only (0700)", projDir !== undefined && (statSync(projDir).mode & 0o777) === 0o700);
  check("store record is owner-only (0600)", recFile !== undefined && projDir !== undefined && (statSync(join(projDir, recFile)).mode & 0o777) === 0o600);
}

// ── 23) truncation honesty + binary handling — fresh server, tiny byte cap ──
const truncTransport = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: { ...process.env, VEIL_MAX_STREAM_BYTES: "2000" } });
const truncClient = new Client({ name: "smoke-trunc", version: "0.0.0" });
await truncClient.connect(truncTransport);
const tr = JSON.parse(text(await truncClient.callTool({ name: "sh_run", arguments: { command: "seq 1 100000" } })));
check("truncation sets stdout_truncated", tr.stdout_truncated === true);
// ASSERT-TRUNC-1: a needle emitted before the byte cap is dropped from the retained
// tail, so a stdout_contains MISS must be flagged inconclusive — not a confident fail.
const trAssert = JSON.parse(text(await truncClient.callTool({ name: "sh_run", arguments: { command: "echo NEEDLE_AT_HEAD; seq 1 100000", expect: { stdout_contains: "NEEDLE_AT_HEAD" } } })));
check("truncated stdout_contains miss is flagged inconclusive", trAssert.stdout_truncated === true && trAssert.assert_ok === false && Array.isArray(trAssert.assertions_failed) && trAssert.assertions_failed.some((a: string) => /truncated|inconclusive/.test(a)));
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

// ── 26) sh_history (Idea 3) — DESCRIPTIVE aggregates over past runs ──
const histDir = mkdtempSync(join(tmpdir(), "veil-hist-state-"));
const hT = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: { ...process.env, VEIL_STATE_DIR: histDir } });
const hC = new Client({ name: "smoke-hist", version: "0.0.0" });
await hC.connect(hT);
const hWork = mkdtempSync(join(tmpdir(), "veil-hist-work-"));
// three identical successful runs → one group, n=3.
for (let i = 0; i < 3; i++) await hC.callTool({ name: "sh_run", arguments: { command: "echo hi", cwd: hWork } });
const hist = JSON.parse(text(await hC.callTool({ name: "sh_history", arguments: { command: "echo hi" } })));
check("sh_history groups exact command with n", hist.groups.length === 1 && hist.groups[0].n === 3 && hist.groups[0].command === "echo hi");
check("sh_history reports exit0 + duration percentiles", hist.groups[0].exit0 === 3 && hist.groups[0].nonzero === 0 && typeof hist.groups[0].duration_ms.p50 === "number");
check("sh_history reports recency window", typeof hist.groups[0].window.first === "string" && typeof hist.groups[0].window.span_h === "number");
check("sh_history is descriptive (note, no prediction)", typeof hist.note === "string" && hist.note.includes("descriptive") && !JSON.stringify(hist).includes("likely"));
// a retry-recovering run is reported as recovered N/M.
const flagH = join(hWork, "flagH");
const retCmd = `test -f ${flagH} && echo ok || (touch ${flagH}; exit 1)`;
const rh = JSON.parse(text(await hC.callTool({ name: "sh_run", arguments: { command: retCmd, cwd: hWork, retries: 1 } })));
check("retry-recovering run succeeded on 2nd attempt", rh.ok === true && rh.attempts === 2);
const histRet = JSON.parse(text(await hC.callTool({ name: "sh_history", arguments: { command: retCmd } })));
check("sh_history surfaces retry recovery", histRet.groups[0].retried === "recovered 1/1");
// like-filter matches the echo group.
const histLike = JSON.parse(text(await hC.callTool({ name: "sh_history", arguments: { like: "echo hi" } })));
check("sh_history like-filter matches the group", histLike.matched === 3 && histLike.groups.some((g: any) => g.command === "echo hi"));
rmSync(hWork, { recursive: true, force: true });
await hC.close();
rmSync(histDir, { recursive: true, force: true });

// ── 27) protect_secrets (TEST-PROTECT) — the BUILT-IN default denylist (~/.ssh …) ──
// Spawn a server with a fake $HOME so defaultSecretPaths() resolves there; prove a
// read of the default ~/.ssh is denied. Without this, the default-denylist branch
// could regress to a no-op and ship green — a FALSE security guarantee.
if (sandboxAvailable()) {
  const fakeHome = mkdtempSync(join(tmpdir(), "veil-home-"));
  mkdirSync(join(fakeHome, ".ssh"));
  writeFileSync(join(fakeHome, ".ssh", "id_rsa"), "PRIVATEKEY\n");
  const psWork = mkdtempSync(join(tmpdir(), "veil-pswork-"));
  const psT = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: { ...process.env, HOME: fakeHome } });
  const psC = new Client({ name: "smoke-protect", version: "0.0.0" });
  await psC.connect(psT);
  const prot = JSON.parse(text(await psC.callTool({ name: "sh_run", arguments: { command: `cat ${join(fakeHome, ".ssh", "id_rsa")}`, cwd: psWork, sandbox: { protect_secrets: true } } })));
  check("protect_secrets blocks reads of the default ~/.ssh", prot.ok === false && !String(prot.stdout ?? "").includes("PRIVATEKEY") && prot.secrets_protected >= 1);
  await psC.close();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(psWork, { recursive: true, force: true });
}

// ── 28) classifier safety corpus (OGL-104) — the historically-risky commands must
// never be UNDER-flagged. Mirror classify.ts's RANK so a corpus case can assert the
// observed category is AT LEAST as severe as its floor (controls assert exact). ──
const CORPUS_RANK: Record<string, number> = { destructive: 5, network: 4, mutating: 3, unknown: 2, "read-only": 1, complex: 0 };
for (const c of CLASSIFY_CORPUS) {
  const got = classify(c.command).category;
  const ok = c.exact ? got === c.minCategory : CORPUS_RANK[got] >= CORPUS_RANK[c.minCategory];
  check(`corpus: ${c.command} ${c.exact ? "==" : ">="} ${c.minCategory} (got ${got})`, ok);
}

// ── 29) per-project checkpoint namespacing (OGL-96) — the SAME label taken from two
// different dirs must not collide: each restore brings back only its own marker. ──
const nsA = mkdtempSync(join(tmpdir(), "veil-ns-a-"));
const nsB = mkdtempSync(join(tmpdir(), "veil-ns-b-"));
writeFileSync(join(nsA, "marker.txt"), "from-A\n");
writeFileSync(join(nsB, "marker.txt"), "from-B\n");
checkpoint("shared", nsA);
checkpoint("shared", nsB); // same label, different dir — must not clobber A's snapshot
check("namespacing: each dir lists its own checkpoint independently", list(nsA).includes("shared") && list(nsB).includes("shared"));
// mutate both, then restore each from its own snapshot.
writeFileSync(join(nsA, "marker.txt"), "MUTATED-A\n");
writeFileSync(join(nsB, "marker.txt"), "MUTATED-B\n");
restore("shared", nsA);
restore("shared", nsB);
check("namespacing: dir A restores A's marker (not B's)", readFileSync(join(nsA, "marker.txt"), "utf8") === "from-A\n");
check("namespacing: dir B restores B's marker (not A's)", readFileSync(join(nsB, "marker.txt"), "utf8") === "from-B\n");
rmSync(nsA, { recursive: true, force: true });
rmSync(nsB, { recursive: true, force: true });

// ── 30) byte-budget store eviction (OGL-101) — fresh server, small VEIL_MAX_STORE_BYTES,
// record-count cap large enough NOT to bind, isolated dir. Several runs each emitting
// >50KB of stdout must blow the byte budget and trim oldest-first: the EARLIEST run's
// record is gone while the most RECENT stays addressable. ──
const byDir = mkdtempSync(join(tmpdir(), "veil-bybytes-"));
const byT = new StdioClientTransport({
  command: "npx",
  args: ["tsx", serverEntry],
  env: { ...process.env, VEIL_STATE_DIR: byDir, VEIL_MAX_STORE_BYTES: "50000", VEIL_MAX_RECORDS: "1000" },
});
const byC = new Client({ name: "smoke-bybytes", version: "0.0.0" });
await byC.connect(byT);
let byFirstId = "";
let byLastId = "";
for (let i = 0; i < 4; i++) {
  // `seq 1 20000` is ~108KB of stdout — each stored record alone exceeds the 50KB
  // budget, so eviction must keep only the newest and drop everything older.
  const r = JSON.parse(text(await byC.callTool({ name: "sh_run", arguments: { command: "seq 1 20000" } })));
  if (i === 0) byFirstId = r.id;
  byLastId = r.id;
}
const byEvicted = JSON.parse(text(await byC.callTool({ name: "sh_detail", arguments: { id: byFirstId, selector: "stdout" } })));
check("byte-budget evicts the earliest record", typeof byEvicted.error === "string" && byEvicted.error.includes("unknown id"));
const byKept = text(await byC.callTool({ name: "sh_detail", arguments: { id: byLastId, selector: "stdout" } }));
check("byte-budget keeps the most recent record", byKept.split("\n").filter(Boolean).length === 20000);
await byC.close();
rmSync(byDir, { recursive: true, force: true });

// ── 31) OGL-98 e2e — scrub_env strips the server's credential-shaped vars from the
// child so a spawned command can't echo them, and discloses the count. A fresh server
// inherits a fake secret in its env; with scrub_env the child sees nothing. ──
const scrubEnv = { ...process.env, FAKE_TOKEN_SECRET: "leakme-12345" };
const scT = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: scrubEnv });
const scC = new Client({ name: "smoke-scrub", version: "0.0.0" });
await scC.connect(scT);
const scrubbed = JSON.parse(text(await scC.callTool({ name: "sh_run", arguments: { command: "echo $FAKE_TOKEN_SECRET", scrub_env: true } })));
check("scrub_env hides the secret value from the child", !String(scrubbed.stdout ?? "").includes("leakme-12345"));
check("scrub_env discloses a non-zero scrubbed count", scrubbed.secrets_env_scrubbed >= 1);
// without scrub_env the same value DOES reach the child — proving the scrub is the cause.
const unscrubbed = JSON.parse(text(await scC.callTool({ name: "sh_run", arguments: { command: "echo $FAKE_TOKEN_SECRET" } })));
check("no scrub_env: child still sees the env value (scrub is the cause)", String(unscrubbed.stdout ?? "").includes("leakme-12345") && !("secrets_env_scrubbed" in unscrubbed));
// sandbox protect_secrets must AUTO-enable env scrubbing (masking ~/.ssh while leaving
// tokens in $env would be inconsistent) — only assertable where a sandbox exists.
if (sandboxAvailable()) {
  const autoWork = mkdtempSync(join(tmpdir(), "veil-scrubauto-"));
  const auto = JSON.parse(text(await scC.callTool({ name: "sh_run", arguments: { command: "echo $FAKE_TOKEN_SECRET", cwd: autoWork, sandbox: { protect_secrets: true } } })));
  check("protect_secrets auto-enables env scrubbing", auto.secrets_env_scrubbed >= 1 && !String(auto.stdout ?? "").includes("leakme-12345"));
  rmSync(autoWork, { recursive: true, force: true });
}
await scC.close();

// ── 32) OGL-99 e2e — no_store keeps a run MEMORY-ONLY: sh_detail works this session
// but NO cmdN.json is ever written to disk. A normal run's record DOES land on disk. ──
const nsDir = mkdtempSync(join(tmpdir(), "veil-nostore-"));
const nsT = new StdioClientTransport({ command: "npx", args: ["tsx", serverEntry], env: { ...process.env, VEIL_STATE_DIR: nsDir } });
const nsClient = new Client({ name: "smoke-nostore", version: "0.0.0" });
await nsClient.connect(nsT);
// the proj-* subdir is created on boot (resolveDir); find it for on-disk assertions.
const nsProj = () => readdirSync(nsDir).filter((f) => f.startsWith("proj-")).map((f) => join(nsDir, f))[0];
const recOnDisk = (id: string) => { const p = nsProj(); return p ? existsSync(join(p, `${id}.json`)) : false; };
const memOnly = JSON.parse(text(await nsClient.callTool({ name: "sh_run", arguments: { command: "echo hi", no_store: true } })));
check("no_store run flagged memory-only", memOnly.stored === "memory-only");
check("no_store run writes NO record file to disk", !recOnDisk(memOnly.id));
// …yet the SAME session can still sh_detail it from the in-memory cache.
const memDetail = text(await nsClient.callTool({ name: "sh_detail", arguments: { id: memOnly.id, selector: "stdout" } }));
check("no_store run still addressable via sh_detail (memory cache)", memDetail.includes("hi"));
// contrast: a normal run IS persisted — its record file appears on disk.
const persisted = JSON.parse(text(await nsClient.callTool({ name: "sh_run", arguments: { command: "echo bye" } })));
check("normal run is not flagged memory-only", persisted.stored !== "memory-only");
check("normal run DOES write a record file to disk", recOnDisk(persisted.id));
await nsClient.close();
rmSync(nsDir, { recursive: true, force: true });

// ── 31) shQuote (shared) + resolveBin (PATH hardening) units ──
check("shQuote wraps a plain string", shQuote("hello") === "'hello'");
// a literal single quote becomes '\'' — close, escaped-quote, reopen.
check("shQuote escapes an embedded single quote", shQuote("a'b") === "'a'\\''b'");
check("shQuote keeps newlines inside the quotes", shQuote("a\nb") === "'a\nb'");
// a real binary in a standard dir resolves to an existing absolute path…
const shPath = resolveBin("sh");
check("resolveBin returns an existing absolute path for a real bin", shPath.startsWith("/") && existsSync(shPath));
// …and an unknown name falls back to the bare name (PATH lookup at exec time).
check("resolveBin falls back to the bare name when not found", resolveBin("veil-no-such-bin-xyz") === "veil-no-such-bin-xyz");

rmSync(STATE_BASE, { recursive: true, force: true });
console.log(failures === 0 ? `\nALL PASS (${total} assertions)` : `\n${failures}/${total} FAILED`);
process.exit(failures === 0 ? 0 : 1);
