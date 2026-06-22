/**
 * Feature K (lite) + B foundation — static command classification.
 *
 * Parses a command string WITHOUT executing it to predict its blast radius and,
 * for known builtins, its file effects. This is best-effort static analysis: shell
 * is Turing-complete, so anything with pipes/expansion/subshells is marked
 * "complex" and only scanned for known-dangerous patterns. No enforcement here —
 * real isolation (landlock/seccomp/sandbox-exec) is a separate kernel layer.
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

/** Naive whitespace tokenizer — only valid for simple, operator-free commands. */
function tokens(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean);
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
    return has(/\s-[a-z]*f/i) ? D("deletes untracked files, irreversible") : R(); // clean only acts with -f
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

  if (SHELL_OPS.test(cmd)) {
    return {
      category: "complex",
      reversible: false,
      mutations: [],
      note: "contains shell operators/expansion; not statically analyzable — review manually",
    };
  }

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

  if (NETWORK.has(bin)) {
    return { category: "network", reversible: false, mutations: [], note: "performs network I/O" };
  }
  if (READ_ONLY.has(bin)) {
    return { category: "read-only", reversible: true, mutations: [] };
  }
  return { category: "unknown", reversible: false, mutations: [], note: `unrecognized command: ${bin}` };
}
