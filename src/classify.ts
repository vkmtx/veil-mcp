/**
 * Feature K (lite) + B foundation — static command classification.
 *
 * Parses a command string WITHOUT executing it to predict its blast radius and,
 * for known builtins, its file effects. This is best-effort STATIC analysis, not an
 * execution dry-run: shell is Turing-complete, so we can never be exhaustive. A
 * top-level pipeline/list (`a && b`, `c | d`, `e; f`) IS decomposed and each segment
 * classified, with the worst case winning the label. Anything with substitution
 * (`$(...)`), redirects, globs, or subshells is genuinely undecidable and stays
 * "complex" — scanned only for known-dangerous patterns. No enforcement here — real
 * isolation (landlock/seccomp/sandbox-exec) is a separate kernel layer.
 *
 * Errors are biased SAFE: the destructive-token scan runs on the raw string, so a
 * dangerous pattern in a quoted ARGUMENT (e.g. `echo "rm -rf /"`) is over-flagged
 * as destructive. This is intentional — stripping quotes to avoid it would instead
 * UNDER-flag a real `bash -c "rm -rf /"`, the unsafe direction. Over-flag, never
 * under-flag.
 */

export type Category = "read-only" | "mutating" | "destructive" | "network" | "complex" | "unknown";

export interface Mutation {
  op: string; // create | delete | move | modify
  paths: string[];
}

export interface Classification {
  category: Category;
  reversible: boolean;
  mutations: Mutation[];
  note?: string;
}

const READ_ONLY = new Set([
  "ls", "cat", "echo", "pwd", "grep", "rg", "find", "head", "tail", "wc", "stat",
  "file", "which", "whoami", "date", "env", "printenv", "du", "df", "tree", "diff",
  // NB: git is intentionally NOT here — its blast radius depends entirely on the
  // subcommand (status vs reset --hard vs push --force), handled by classifyGit.
]);
const NETWORK = new Set([
  "curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "rsync", "ping", "dig", "host", "telnet", "ftp",
]);
const DESTRUCTIVE_TOKENS = [
  // rm with a force flag: `-f` anywhere in a short-flag cluster (so `-rf`, `-fr`,
  // `-rfv` all match, not just f-last), SPLIT flags (`rm -r -f`), and `--force` —
  // even inside a pipeline (`find . | xargs rm -r -f`). The [^|;&\n] guard stops the
  // match from crossing a shell operator into an unrelated rm.
  /\brm\b[^|;&\n]*\s-[a-z]*f[a-z]*\b|\brm\b[^|;&\n]*\s--force(\s|$)/i,
  /\bdd\b/i,
  /\bmkfs/i,
  // find that deletes — `-delete` or `-exec rm` — even with globs/`;` that would
  // otherwise route to "complex". Bounded by shell operators (the trailing `\;` is fine).
  /\bfind\b[^|;&\n]*\s-delete\b/i,
  /\bfind\b[^|;&\n]*-exec\s+rm\b/i,
  // Redirect into a raw block device. `>` is not a word char, so a leading \b
  // could never match (the prior /\b>\.../ was dead) — anchor on the redirect itself.
  />\s*\/dev\/(sd|disk|hd|nvme|vd|mapper)/i,
  // Fork bomb `:(){ :|:& };:`. The prior /\b:.../ was dead (\b never matches before
  // a leading ':'); anchor on a start/operator boundary instead.
  /(^|[\s;&|])\:\s*\(\)\s*\{/,
];

const SHELL_OPS = /[|;&]|&&|\|\||\$\(|`|>|<|\*|\?/;

/** Strip a single matched pair of surrounding quotes from a token, so a quoted
 *  command/subcommand classifies like its bare form (`git "reset"` → `reset`).
 *  Without this a quoted destructive subcommand silently under-flags to "unknown". */
function stripMatchedQuotes(t: string): string {
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
}

/** Naive whitespace tokenizer — only valid for simple, operator-free commands.
 *  Surrounding quotes are stripped per token (see stripMatchedQuotes). */
function tokens(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean).map(stripMatchedQuotes);
}

function nonFlagArgs(toks: string[]): string[] {
  return toks.slice(1).filter((t) => !t.startsWith("-"));
}

const WRAPPERS = new Set([
  "sudo", "doas", "env", "nice", "nohup", "command", "time", "timeout", "stdbuf", "setsid", "ionice", "xargs", "busybox",
]);

/**
 * Flags that consume the FOLLOWING token as a value, PER WRAPPER. Per-wrapper (not a
 * global set) so a valueless flag like `sudo -i` never eats the real command.
 */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p", "-t"]),
  xargs: new Set(["-n", "-I", "-i", "-L", "-P", "-s", "-d", "-a", "-E"]),
  sudo: new Set(["-u", "-g", "-U", "-C", "-p", "-r", "-t", "-h"]),
  env: new Set(["-u"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k"]),
};

/**
 * Strip leading wrapper binaries (sudo/env/nice/timeout/xargs/…) so the REAL command
 * is what gets classified — otherwise `timeout 5 git push --force` reads as unknown.
 * Skips the wrapper's own flags (and their values, per WRAPPER_VALUE_FLAGS),
 * `env VAR=val` assignments, and `timeout`'s leading duration positional. Never
 * empties argv (bare `env` stays `env`).
 */
function unwrap(toks: string[]): string[] {
  let t = toks;
  for (let guard = 0; guard < 8; guard++) {
    const head = (t[0] ?? "").split("/").pop() ?? "";
    if (!WRAPPERS.has(head)) break;
    const valueFlags = WRAPPER_VALUE_FLAGS[head];
    let i = 1;
    if (head === "env") while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
    while (i < t.length && t[i].startsWith("-")) {
      const flag = t[i];
      i++;
      if (valueFlags?.has(flag) && i < t.length && !t[i].startsWith("-")) i++; // skip its value
    }
    // `timeout DURATION cmd` / `timeout DURATION[smhd] cmd` — skip the duration positional.
    if (head === "timeout" && i < t.length && /^\d+(\.\d+)?[smhd]?$/.test(t[i])) i++;
    const rest = t.slice(i);
    if (rest.length === 0) break; // nothing real follows — keep the wrapper as the command
    t = rest;
  }
  return t;
}

/**
 * Destination path(s) for cp/ln. GNU `-t DIR` / `--target-directory[=DIR]`
 * overrides the default "last positional is the destination" convention.
 */
function copyDest(toks: string[]): string[] {
  const rest = toks.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "-t" || t === "--target-directory") {
      return rest[i + 1] ? [rest[i + 1]] : ["(target-directory: missing value)"];
    }
    const m = t.match(/^--target-directory=(.+)$/);
    if (m) return [m[1]];
  }
  return nonFlagArgs(toks).slice(-1);
}

const GIT_READ = new Set([
  "status", "log", "diff", "show", "branch", "ls-files", "rev-parse", "describe",
  "blame", "cat-file", "config", "help", "remote", "tag", "shortlog", "reflog", "grep",
]);
const GIT_NETWORK = new Set(["fetch", "pull", "clone"]);
const GIT_MUTATING = new Set(["add", "commit", "mv", "stash", "merge", "cherry-pick", "apply", "am", "init"]);

/** Find the git subcommand, skipping global flags and their values (-C dir, -c k=v). */
function gitSubcommand(toks: string[]): string {
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree") {
      i++; // skip this flag's value
      continue;
    }
    if (t.startsWith("-")) continue;
    return t;
  }
  return "";
}

/**
 * git's blast radius is per-subcommand, not per-binary. A force-push or
 * `reset --hard` is irreversible and must never read as "read-only".
 */
function classifyGit(toks: string[]): Classification {
  const sub = gitSubcommand(toks);
  const rest = toks.join(" ");
  const has = (re: RegExp) => re.test(rest);

  const D = (note: string): Classification => ({ category: "destructive", reversible: false, mutations: [], note });
  const M = (note?: string): Classification => ({ category: "mutating", reversible: true, mutations: [], note });
  const N = (note: string): Classification => ({ category: "network", reversible: false, mutations: [], note });
  const R = (): Classification => ({ category: "read-only", reversible: true, mutations: [] });

  if (sub === "push") {
    if (has(/\s(--force|-f|--force-with-lease)\b/)) return D("force-push — rewrites remote history, irreversible");
    if (has(/\s--delete\b/) || has(/\s:[^\s]/)) return D("deletes a remote branch"); // push --delete / push origin :branch
    return N("publishes commits to a remote");
  }
  if (sub === "reset") {
    const hard = has(/\s--hard\b/);
    return hard ? D("reset --hard discards working-tree and staged changes") : M("moves HEAD/index");
  }
  if (sub === "clean") {
    // Force can be a bundled short cluster (-f / -fd / -fdx / -df) OR the long
    // --force — the sibling subcommands accept both, and clean must too. Missing
    // --force here made `git clean --force` read as read-only: no effect-tracking,
    // no destructive nudge, while it irreversibly deletes every untracked file.
    return has(/\s(--force|-[a-z]*f[a-z]*)\b/i) ? D("deletes untracked files, irreversible") : R();
  }
  if (sub === "checkout" || sub === "restore" || sub === "switch") {
    // Discarding worktree changes (path checkout, --worktree, --force) is data loss.
    if (has(/\s--(\s|$)/) || has(/--worktree\b/) || has(/\s(--force|-f)\b/)) {
      return D("discards uncommitted changes in the working tree");
    }
    return M("can overwrite uncommitted changes in the working tree");
  }
  if (sub === "rebase" || sub === "filter-branch") return D("rewrites commit history");
  if (sub === "rm") return M("removes tracked files from the index/worktree");
  if (sub === "branch") {
    if (has(/\s-[a-zA-Z]*D\b/) || (has(/--delete\b/) && has(/\s(--force|-f)\b/))) return D("force-deletes a branch");
    if (has(/\s-d\b/) || has(/--delete\b/)) return M("deletes a (merged) branch");
    return R();
  }
  if (sub === "tag") {
    return has(/\s-d\b/) || has(/--delete\b/) ? M("deletes a tag") : R();
  }
  if (sub === "remote") {
    return has(/\bremote\s+(add|remove|rm|set-url|rename|prune)\b/) ? M("changes remote config") : R();
  }
  if (sub === "stash") {
    return has(/\bstash\s+(clear|drop)\b/) ? D("discards stashed changes irreversibly") : M("stashes/restores working-tree changes");
  }
  if (sub === "worktree") {
    if (has(/\bworktree\s+(remove|prune)\b/)) return D("removes a worktree");
    if (has(/\bworktree\s+add\b/)) return M("adds a worktree");
    return R();
  }
  if (sub === "submodule" && has(/\bsubmodule\s+deinit\b/)) return D("deinitializes a submodule");

  if (GIT_NETWORK.has(sub)) return N("network I/O against a remote");
  if (GIT_MUTATING.has(sub)) return M();
  if (GIT_READ.has(sub)) return R();
  // Unknown subcommand (or an unresolved alias): stay conservative.
  return { category: "unknown", reversible: false, mutations: [], note: `unrecognized git subcommand: ${sub || "(none)"}` };
}

/**
 * find's blast radius is its ACTION, not the binary. `-delete` removes every match;
 * `-exec`/`-execdir`/`-ok`/`-okdir` run an arbitrary utility per match. So classify
 * that embedded command instead of trusting `find` as read-only — the prior bug read
 * `find … -exec shred {} \;` (and `-execdir rm`, `-exec /bin/rm`, `-exec git reset
 * --hard`) as read-only, the worst possible under-flag. A read-only payload (`-exec
 * cat`) still correctly stays read-only.
 */
function classifyFind(toks: string[]): Classification {
  if (toks.includes("-delete")) {
    return { category: "destructive", reversible: false, mutations: [{ op: "delete", paths: ["(files matched by find)"] }], note: "find -delete removes matched files" };
  }
  const ei = toks.findIndex((t) => t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir");
  if (ei >= 0) {
    const after = toks.slice(ei + 1);
    // the payload runs from the token after -exec up to a terminating `;` / `\;` / `+`
    const term = after.findIndex((t) => t === ";" || t === "\\;" || t === "+");
    const sub = (term >= 0 ? after.slice(0, term) : after).filter((t) => t !== "{}").join(" ").trim();
    const inner: Classification = sub ? classifyAtom(sub) : { category: "unknown", reversible: false, mutations: [] };
    return { ...inner, note: `find ${toks[ei]} runs \`${sub || "?"}\`${inner.note ? ` — ${inner.note}` : ""}` };
  }
  return { category: "read-only", reversible: true, mutations: [] };
}

const ALWAYS_INTERACTIVE = new Set([
  "vim", "vi", "nvim", "nano", "emacs", "pico", "joe", "less", "more", "most", "top", "htop", "man", "vimtutor",
]);
const REPL_BINS = new Set(["python", "python3", "node", "irb", "ruby", "php", "psql", "mysql", "sqlite3"]);

/**
 * Heuristic: would this command want a TTY that veil can't provide (it buffers
 * output and has no terminal)? Used only to ADVISE falling back to raw Bash — never
 * to block. Conservative: piped/redirected forms and REPLs given a script are not
 * flagged.
 */
export function looksInteractive(command: string): boolean {
  const cmd = command.trim();
  if (SHELL_OPS.test(cmd)) return false; // a pipe/redirect feeds input → not a bare TTY session
  const toks = unwrap(tokens(cmd));
  const bin = (toks[0] ?? "").split("/").pop() ?? "";
  if (ALWAYS_INTERACTIVE.has(bin)) return true;
  if (REPL_BINS.has(bin) && nonFlagArgs(toks).length === 0) return true; // bare REPL prompt
  if (bin === "ssh" && nonFlagArgs(toks).length <= 1) return true; // login shell, no remote command
  return false;
}

/** Severity order for aggregating a pipeline/list: the worst segment wins the label,
 *  but every segment's mutations and notes are merged so detail isn't lost. */
const RANK: Record<Category, number> = {
  destructive: 5,
  network: 4,
  mutating: 3,
  unknown: 2,
  "read-only": 1,
  complex: 0,
};

/**
 * Split a command into top-level segments at `&&`, `||`, `;`, and `|`, respecting
 * quotes. Returns null (→ caller treats it as "complex") if it hits a construct we
 * refuse to guess through: command substitution (`$(`/backtick), redirects (`<`/`>`),
 * globs (`*`/`?`), subshells/braces, background (`&`), or an unterminated quote.
 * This turns the common `cd x && npm build` / `cat f | grep y` shapes from an opaque
 * "complex" into a real per-segment classification, without pretending to parse the
 * genuinely-undecidable cases.
 */
function splitSegments(cmd: string): string[] | null {
  const segs: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    // A backslash escapes the next char: it is literal text, never a split point or
    // a bail (so `find … \;`, `\&`, `\|` stay inside the atom rather than truncating
    // it — the prior bug dropped a `find -exec` payload by splitting on the `\;`).
    if (c === "\\") { cur += c + (next ?? ""); i++; continue; }
    // constructs we won't statically reason through → bail to "complex"
    if (c === "`" || (c === "$" && next === "(")) return null; // command substitution
    if (c === "<" || c === ">") return null;                   // redirect (target unparsed)
    if (c === "*" || c === "?") return null;                   // glob
    if (c === "(" || c === ")") return null;                   // subshell (braces are
    //                                                         // usually literal args:
    //                                                         // xargs/find `{}`, brace
    //                                                         // expansion — let the
    //                                                         // atom classifier judge)
    // split points
    if (c === "&" && next === "&") { segs.push(cur); cur = ""; i++; continue; }
    if (c === "&") return null; // background — changes execution semantics
    if (c === "|" && next === "|") { segs.push(cur); cur = ""; i++; continue; }
    if (c === "|") { segs.push(cur); cur = ""; continue; }
    if (c === ";") { segs.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (quote) return null; // unterminated quote — don't guess
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

/** Combine segment classifications into one: worst category wins, mutations and
 *  notes merge, and the result is reversible only if every segment is. */
function aggregate(parts: Classification[]): Classification {
  let worst = parts[0];
  for (const p of parts) if (RANK[p.category] > RANK[worst.category]) worst = p;
  const notes = parts.map((p) => p.note).filter(Boolean) as string[];
  return {
    category: worst.category,
    reversible: parts.every((p) => p.reversible),
    mutations: parts.flatMap((p) => p.mutations),
    note: `pipeline/list of ${parts.length} segments; worst = ${worst.category}` + (notes.length ? ` — ${notes.join("; ")}` : ""),
  };
}

export function classify(command: string): Classification {
  const cmd = command.trim();

  // Dangerous patterns are checked even inside complex commands.
  for (const pat of DESTRUCTIVE_TOKENS) {
    if (pat.test(cmd)) {
      return {
        category: "destructive",
        reversible: false,
        mutations: [{ op: "delete", paths: ["(matched a destructive pattern)"] }],
        note: `command matches a known-destructive pattern (${pat})`,
      };
    }
  }

  // Decompose top-level pipelines/lists. A non-null result means the splitter ran
  // cleanly (quotes respected, no undecidable construct): classify each atom and take
  // the worst case, or classify the lone atom directly — note a quoted operator
  // (`echo "a && b"`) yields one clean atom, NOT a false "complex". splitSegments
  // returns null ONLY for the genuinely-undecidable shells (substitution, redirect,
  // glob, subshell, background, unterminated quote), which stay "complex".
  const segs = splitSegments(cmd);
  if (segs) {
    return segs.length > 1 ? aggregate(segs.map((s) => classifyAtom(s))) : classifyAtom(segs[0] ?? cmd);
  }

  // splitSegments bailed on an undecidable construct (substitution / redirect /
  // glob / subshell / background). Demoting straight to "complex" (RANK 0) would
  // HIDE a destructive verb that only the atom/git classifier detects — e.g.
  // `rm *`, `shred f > /dev/null`, `git reset --hard $(…)` — sinking it below
  // read-only and skipping the destructive nudge. Re-run the atom classifier on
  // the whole command and keep it only when it surfaces a high-blast category;
  // otherwise the command really is unanalyzable → honest "complex".
  const whole = classifyAtom(cmd);
  if (whole.category === "destructive" || whole.category === "network") {
    return { ...whole, note: `${whole.note ?? whole.category} (within an otherwise unanalyzable command)` };
  }

  return {
    category: "complex",
    reversible: false,
    mutations: [],
    note: "contains shell substitution/redirection/glob; not statically analyzable — review manually",
  };
}

/** Classify a SINGLE command atom (no top-level connectors). */
function classifyAtom(command: string): Classification {
  const cmd = command.trim();
  const toks = unwrap(tokens(cmd));
  const bin = (toks[0] ?? "").split("/").pop() ?? "";
  const args = nonFlagArgs(toks);

  switch (bin) {
    case "rm":
      return { category: "destructive", reversible: false, mutations: [{ op: "delete", paths: args }] };
    case "rmdir":
      return { category: "mutating", reversible: false, mutations: [{ op: "delete", paths: args }] };
    case "mv":
      return { category: "mutating", reversible: true, mutations: [{ op: "move", paths: args }] };
    case "cp":
      return { category: "mutating", reversible: true, mutations: [{ op: "create", paths: copyDest(toks) }] };
    case "mkdir":
      return { category: "mutating", reversible: true, mutations: [{ op: "create", paths: args }] };
    case "touch":
      return { category: "mutating", reversible: true, mutations: [{ op: "create", paths: args }] };
    case "ln":
      return { category: "mutating", reversible: true, mutations: [{ op: "create", paths: copyDest(toks) }] };
    case "chmod":
    case "chown":
      return { category: "mutating", reversible: true, mutations: [{ op: "modify", paths: args }] };
    case "shred":
      return { category: "destructive", reversible: false, mutations: [{ op: "delete", paths: args }], note: "irreversibly overwrites file contents" };
    case "truncate": {
      // `-s 0` / `--size 0` wipes contents (data loss); otherwise it resizes (mutating).
      const zero = /(^|\s)(-s\s*0|--size(=|\s+)0)(\s|$)/.test(cmd);
      return zero
        ? { category: "destructive", reversible: false, mutations: [{ op: "modify", paths: args }], note: "truncate to 0 — discards file contents" }
        : { category: "mutating", reversible: false, mutations: [{ op: "modify", paths: args }] };
    }
    case "mkfifo":
    case "mknod":
      return { category: "mutating", reversible: true, mutations: [{ op: "create", paths: args }] };
    case "sed":
      // in-place edit mutates the file; a plain stream edit is read-only.
      return /(^|\s)(-i|--in-place)\b/.test(cmd)
        ? { category: "mutating", reversible: false, mutations: [{ op: "modify", paths: args }], note: "in-place edit" }
        : { category: "read-only", reversible: true, mutations: [] };
  }

  if (bin === "git") {
    return classifyGit(toks);
  }
  // find is in READ_ONLY for plain searches, but its -exec/-delete actions are not —
  // classify the action, not the binary. (Must precede the READ_ONLY check below.)
  if (bin === "find") {
    return classifyFind(toks);
  }

  if (NETWORK.has(bin)) {
    return { category: "network", reversible: false, mutations: [], note: "performs network I/O" };
  }
  if (READ_ONLY.has(bin)) {
    return { category: "read-only", reversible: true, mutations: [] };
  }
  return { category: "unknown", reversible: false, mutations: [], note: `unrecognized command: ${bin}` };
}
