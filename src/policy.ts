/**
 * Feature K — real sandbox enforcement.
 *
 * Confines a command's blast radius at the KERNEL level, not by static guesswork.
 * On macOS this uses `sandbox-exec` (Seatbelt/SBPL) — unprivileged, no sudo, no
 * SIP changes. The default policy is "write-confine": reads/exec stay allowed, but
 * file WRITES are denied everywhere except the working dir, the temp dir, and the
 * handful of device files programs need. Network can be denied too.
 *
 * This is the one guarantee a presentation layer (or a forked shell) cannot give
 * on its own — it lives in the kernel. `sandbox-exec` is deprecated by Apple but
 * still functional and the standard unprivileged option on macOS.
 *
 * On Linux there are TWO backends, tried in order of capability:
 *   1. bubblewrap (`bwrap`) — full write-confine + network-deny + secret read-mask,
 *      but needs working UNPRIVILEGED user namespaces (containers / CI / Ubuntu
 *      24.04+ often restrict these).
 *   2. Landlock via `landrun` — a namespace-FREE kernel LSM that works exactly where
 *      bwrap can't (containers, locked-down CI). Scoped: WRITE-confine only in v1;
 *      it refuses (rather than fakes) network-deny and secret read-confine, since
 *      Landlock is an allow-list model. Kernel 5.13+; reported unavailable otherwise.
 * Both arg-builders are unit-tested; bwrap live write-confine is asserted on the
 * Ubuntu CI leg. Treat the Linux paths as experimental.
 *
 * HONESTY CONTRACT: if a sandbox is requested but unavailable, the caller MUST
 * refuse to run — never silently execute unconfined. `sandboxAvailable()` is how
 * the caller checks before relying on confinement. A backend that cannot enforce a
 * REQUESTED knob (e.g. Landlock + network-deny) throws so the caller refuses too.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { resolve, dirname, basename, join } from "node:path";

export interface SandboxOpts {
  /** allow network access (default true). false → deny all network. */
  network?: boolean;
  /** extra writable paths (subpaths), beyond cwd and the temp dir. */
  writable?: string[];
  /**
   * Paths whose CONTENTS are blocked from being read under the sandbox (a secret
   * denylist: ~/.ssh, ~/.aws, …). macOS: `(deny file-read* (subpath …))`. Linux:
   * the path is masked with an empty `--tmpfs`, so it must be an existing DIRECTORY.
   * This is a SCOPED guarantee — it blocks reads of the configured paths, NOT a
   * proof the agent cannot exfiltrate by any means. See registerShRun's honesty note.
   */
  denyRead?: string[];
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Well-known credential DIRECTORIES, used when sh_run is asked to protect secrets
 * with no explicit list. Directories only (not single files like ~/.netrc) so the
 * Linux `--tmpfs` masking is uniform across backends. Resolved against $HOME.
 */
export function defaultSecretPaths(): string[] {
  const h = homedir();
  if (!h) return [];
  return [
    join(h, ".ssh"),
    join(h, ".aws"),
    join(h, ".gnupg"),
    join(h, ".config", "gcloud"),
    join(h, ".config", "gh"),
    join(h, ".kube"),
    join(h, ".docker"),
  ];
}

/**
 * Names that LOOK like secrets — matched case-insensitively against env var names
 * by scrubSecretEnv. Two groups: generic credential-shaped substrings (a name that
 * mentions a token / key / password / secret / credential / session-token is treated
 * as sensitive), and well-known provider prefixes whose vars are almost always creds.
 *
 * This is a best-effort DENYLIST, not a guarantee: it catches the conventional names
 * but cannot know an arbitrarily-named secret (e.g. `FOO=<api key>`). It is scoped to
 * keeping the SERVER's own credentials out of spawned commands — not proof against
 * exfiltration. Benign infra vars (PATH, HOME, …) are protected by ENV_KEEP below.
 */
export const SECRET_ENV_PATTERNS: RegExp[] = [
  // Generic credential-shaped substrings, anywhere in the name.
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /(^|_)PWD$/i, //   trailing PWD (PG_PWD) — but PWD itself is the working dir; see ENV_KEEP.
  /CREDENTIAL/i, //  also matches CREDENTIALS
  // Only credential-shaped session vars — a bare /SESSION/ would also strip benign
  // desktop vars (DBUS_SESSION_BUS_ADDRESS, SESSION_MANAGER, XDG_SESSION_*) that
  // keyring / gpg-agent / git-credential commands legitimately need.
  /SESSION_?(TOKEN|KEY|SECRET)/i,
  /PRIVATE_?KEY/i,
  /ACCESS_?KEY/i,
  /API_?KEY/i,
  /(^|_)KEY$/i, //   trailing _KEY (SIGNING_KEY) without flagging KEYBOARD/KEYWORD etc.
  // Well-known provider prefixes — their vars are almost always credentials.
  /^AWS_/i,
  /^GITHUB_/i,
  /^GH_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^AZURE_/i,
  /^STRIPE_/i,
  /^SLACK_/i,
  /^NPM_TOKEN$/i, //  (already covered by /TOKEN/, kept for explicitness)
  /^HF_/i,
  /^HUGGINGFACE_/i,
];

/**
 * Infrastructure vars a command legitimately needs — never scrubbed even if a
 * pattern above would otherwise match (PWD matches the trailing-PWD rule). Compared
 * case-insensitively; LC_* is allowed by prefix.
 */
const ENV_KEEP = new Set(
  ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR", "PWD", "NODE_ENV", "CI"].map((n) => n.toUpperCase()),
);

/** True if `name` is a benign infra var that must survive scrubbing. */
function isKept(name: string): boolean {
  const up = name.toUpperCase();
  return ENV_KEEP.has(up) || up.startsWith("LC_");
}

/**
 * Return a COPY of `env` with well-known secret-shaped variables removed, plus the
 * sorted list of removed names (so the caller can HONESTLY disclose what it dropped).
 *
 * Policy (case-insensitive, see SECRET_ENV_PATTERNS): names containing SECRET, TOKEN,
 * PASSWORD/PASSWD, a trailing _PWD, CREDENTIAL(S), SESSION_TOKEN/KEY, PRIVATE_KEY, ACCESS_KEY,
 * API_KEY/APIKEY, a trailing _KEY; plus the common provider prefixes (AWS_, GITHUB_/GH_,
 * OPENAI_, ANTHROPIC_, GOOGLE_/GCP_, AZURE_, STRIPE_, SLACK_, NPM_TOKEN, HF_/HUGGINGFACE_).
 *
 * Infra vars in ENV_KEEP (PATH, HOME, USER, SHELL, LANG, LC_*, TERM, TMPDIR, PWD,
 * NODE_ENV, CI) are always kept so commands still run. Anything not matching a pattern
 * is left untouched.
 *
 * BEST-EFFORT: a denylist of conventional names — it does NOT catch an arbitrarily
 * named secret and is not proof against exfiltration. It is scoped to keeping the
 * server's own environment credentials out of spawned commands.
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; scrubbed: string[] } {
  const out: NodeJS.ProcessEnv = {};
  const scrubbed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isKept(name) && SECRET_ENV_PATTERNS.some((re) => re.test(name))) {
      scrubbed.push(name);
      continue;
    }
    out[name] = env[name];
  }
  scrubbed.sort();
  return { env: out, scrubbed };
}

/** Device files programs commonly need to write even under tight confinement. */
const DEV_WRITES = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/dtracehelper"];

let cachedBwrap: boolean | undefined;

/**
 * Can bubblewrap actually confine here? A bare `--version` check would lie: bwrap
 * needs working UNPRIVILEGED user namespaces, which Ubuntu 24.04+ restricts by
 * default (AppArmor `kernel.apparmor_restrict_unprivileged_userns`). Self-test by
 * really creating a namespace; if it can't, report unavailable so sh_run refuses
 * rather than running a bwrap that fails before the command. Probed once per process.
 */
function hasBwrap(): boolean {
  if (cachedBwrap !== undefined) return cachedBwrap;
  try {
    execFileSync("bwrap", ["--unshare-pid", "--ro-bind", "/", "/", "/bin/true"], { stdio: "ignore" });
    cachedBwrap = true;
  } catch {
    cachedBwrap = false;
  }
  return cachedBwrap;
}

let cachedLandlock: boolean | undefined;

/**
 * Can Landlock (via `landrun`) actually confine here? We do NOT trust landrun's exit
 * code or `--version` — a tool that silently runs unconfined on a pre-5.13 kernel
 * would make veil claim `sandboxed` while running free, the worst honesty violation.
 * Instead EMPIRICALLY prove confinement: grant write to a throwaway dir only, then in
 * one confined shell write a marker INSIDE it (must land → proves the command really
 * executed, not a pre-exec abort) and attempt a write OUTSIDE every grant (must be
 * denied → proves Landlock enforced). Available only if BOTH hold. Namespace-free, so
 * this is true in containers where bwrap is not. Probed once per process.
 */
function hasLandlock(): boolean {
  if (cachedLandlock !== undefined) return cachedLandlock;
  cachedLandlock = false;
  let dir: string | undefined;
  const escape = join(tmpdir(), `veil-ll-escape-${process.pid}`);
  try {
    rmSync(escape, { force: true });
    // Canonicalize the probe dir so the grant matches where the marker is actually
    // written (production canonicalizes its roots too; tmpdir may be symlinked).
    dir = mkdtempSync(join(tmpdir(), "veil-ll-"));
    try { dir = realpathSync(dir); } catch { /* keep the unresolved path */ }
    const marker = join(dir, "ok");
    // Mirror the production grant set (--rox / + --rwx /dev + the writable roots) so
    // the probe enforces exactly what a real run would. --rwx <dir> is the only
    // FILESYSTEM write grant; the marker write must succeed, the escape write (outside
    // every grant) must not.
    try {
      execFileSync(
        "landrun",
        ["--rox", "/", "--rwx", "/dev", "--rwx", dir, "--", "/bin/sh", "-c", `printf x > ${marker}; printf y > ${escape}`],
        { stdio: "ignore" },
      );
    } catch {
      /* nonzero is EXPECTED — the denied escape write makes the shell exit nonzero */
    }
    cachedLandlock = existsSync(marker) && !existsSync(escape);
  } catch {
    cachedLandlock = false; // landrun absent or the probe could not be set up
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(escape, { force: true });
  }
  return cachedLandlock;
}

/**
 * True where real kernel confinement is available: macOS (sandbox-exec), or Linux
 * with bubblewrap OR Landlock (`landrun`). Fail-closed everywhere else, so callers
 * refuse rather than run unconfined.
 */
export function sandboxAvailable(): boolean {
  if (process.platform === "darwin") return existsSync(SANDBOX_EXEC);
  if (process.platform === "linux") return hasBwrap() || hasLandlock();
  return false;
}

/**
 * Resolve a path to its canonical (symlink-free) ABSOLUTE form — sandbox matches
 * on canonical paths. Works even when the leaf doesn't exist yet (e.g. a writable
 * dir to be created): walks up to the nearest existing ancestor, resolves THAT,
 * then re-appends the unresolved tail (so /tmp/new → /private/tmp/new).
 */
function canonical(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the root with nothing resolvable
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Canonical, validated writable roots: cwd, the temp dir, and any extra `writable`
 * entries (resolved against cwd). Rejects a path with a quote/newline/backslash,
 * which would break the shell arg or the profile literal it gets embedded in.
 */
function safeWriteRoots(cwd: string, opts: SandboxOpts): string[] {
  const roots = [
    canonical(cwd),
    canonical(tmpdir()),
    ...(opts.writable ?? []).map((w) => canonical(resolve(cwd, w))),
  ];
  for (const p of roots) {
    if (/["'\n\\]/.test(p)) throw new Error(`unsafe path in sandbox writable set: ${JSON.stringify(p)}`);
  }
  return roots;
}

/** Canonical, validated read-deny roots (the secret denylist), same path-safety
 *  rejection as the writable set so they can't break the profile/arg literal. */
function safeDenyReads(opts: SandboxOpts): string[] {
  const roots = (opts.denyRead ?? []).map((p) => canonical(p));
  for (const p of roots) {
    if (/["'\n\\]/.test(p)) throw new Error(`unsafe path in sandbox denyRead set: ${JSON.stringify(p)}`);
  }
  return roots;
}

/**
 * Build an SBPL profile (macOS). Rule order matters: later rules win, so we allow
 * everything, deny ALL writes, then re-allow the permitted write roots.
 */
export function buildProfile(cwd: string, opts: SandboxOpts = {}): string {
  const subpaths = safeWriteRoots(cwd, opts).map((p) => `  (subpath ${JSON.stringify(p)})`).join("\n");
  const devs = DEV_WRITES.map((p) => `  (literal ${JSON.stringify(p)})`).join("\n");
  const net = opts.network === false ? "(deny network*)\n" : "";
  // Secret read-deny goes LAST so it wins over `(allow default)` — block reads of
  // the configured secret subpaths even though everything else stays readable.
  const denyReads = safeDenyReads(opts);
  const readDeny = denyReads.length
    ? `(deny file-read*\n${denyReads.map((p) => `  (subpath ${JSON.stringify(p)})`).join("\n")}\n)\n`
    : "";
  return (
    `(version 1)\n` +
    `(allow default)\n` +
    `(deny file-write*)\n` +
    `(allow file-write*\n${subpaths}\n${devs}\n  (subpath "/dev/fd")\n)\n` +
    net +
    readDeny
  );
}

/** Single-quote a string for /bin/sh (safe for newlines and embedded double-quotes). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a bubblewrap (Linux) command line for the same write-confine policy:
 * bind the whole filesystem read-only, then re-bind the writable roots rw, give a
 * minimal /dev and /proc, --chdir into the (bound, writable) cwd — bwrap does NOT
 * inherit the parent's working directory, so without this the child runs in `/`
 * (read-only) and even cwd-local writes fail — and (when network is denied) unshare
 * the network namespace. EXPERIMENTAL: arg construction is unit-tested and live
 * confinement is asserted by a Linux CI test; fail-closed (no bwrap → unavailable).
 */
export function buildBwrapArgs(command: string, cwd: string, opts: SandboxOpts = {}): string {
  const binds = safeWriteRoots(cwd, opts)
    .map((p) => `--bind ${shQuote(p)} ${shQuote(p)}`)
    .join(" ");
  const net = opts.network === false ? "--unshare-net " : "";
  // Mask each secret dir with an empty tmpfs so its real contents are unreadable.
  // Placed AFTER --ro-bind / / so it overlays the bound host path; the path must be
  // an existing directory (sh_run filters to existing dirs before calling here).
  const mask = safeDenyReads(opts)
    .map((p) => `--tmpfs ${shQuote(p)}`)
    .join(" ");
  // --unshare-pid is required for `--proc /proc` to mount (else bwrap exits nonzero).
  return (
    `bwrap --unshare-pid --ro-bind / / --dev /dev --proc /proc ${binds}${mask ? " " + mask : ""} --chdir ${shQuote(canonical(cwd))} ` +
    `${net}--die-with-parent /bin/sh -c ${shQuote(command)}`
  );
}

/**
 * Build a Landlock (`landrun`) command line — the namespace-free Linux backend for
 * containers/CI where bwrap can't run. Grant read+exec on the whole tree (so binaries
 * and shared libs load), write on /dev (devices like /dev/null), and read-write-exec
 * on the confined roots (cwd + temp + extras); everything else is read-only. No
 * `--best-effort`, so landrun aborts rather than run unconfined on a kernel without
 * Landlock — preserving the honesty contract.
 *
 * SCOPED, v1: write-confine only. Landlock is an allow-list model, so a secret
 * read-DENY can't be expressed as a subtraction, and network confinement is
 * kernel/ABI-dependent — so this THROWS (caller then refuses) when `network:false`
 * or `denyRead` is requested, rather than silently failing to enforce them.
 */
export function buildLandrunArgs(command: string, cwd: string, opts: SandboxOpts = {}): string {
  if (opts.network === false) {
    throw new Error("landlock backend cannot enforce network deny — install bubblewrap (bwrap) for network confinement");
  }
  if (opts.denyRead && opts.denyRead.length) {
    throw new Error("landlock backend cannot enforce secret read-confine (allow-list model) — install bubblewrap (bwrap) or run on macOS");
  }
  const rwx = safeWriteRoots(cwd, opts)
    .map((p) => `--rwx ${shQuote(p)}`)
    .join(" ");
  // --rox / : read+exec everywhere; --rwx /dev : writable devices (/dev/null etc.);
  // --rwx <roots> : the only writable filesystem locations.
  return `landrun --rox / --rwx /dev ${rwx} -- /bin/sh -c ${shQuote(command)}`;
}

/**
 * Wrap `command` so it runs under the platform sandbox. The result is a shell
 * command line (run via the normal shell:true path). Throws if a writable path is
 * unsafe or the platform is unsupported; callers must have checked sandboxAvailable().
 * On Linux, prefer bubblewrap (more capable) and fall back to Landlock (`landrun`)
 * where user namespaces are unavailable.
 */
export function wrapCommand(command: string, cwd: string, opts: SandboxOpts = {}): string {
  if (process.platform === "darwin") {
    const profile = buildProfile(cwd, opts);
    return `${SANDBOX_EXEC} -p ${shQuote(profile)} /bin/sh -c ${shQuote(command)}`;
  }
  if (process.platform === "linux") {
    if (hasBwrap()) return buildBwrapArgs(command, cwd, opts);
    if (hasLandlock()) return buildLandrunArgs(command, cwd, opts);
    throw new Error("no Linux sandbox backend available (need bubblewrap or Landlock/landrun)");
  }
  throw new Error(`sandbox not supported on platform: ${process.platform}`);
}
