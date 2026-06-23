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
 * still functional and the standard unprivileged option on macOS. A Linux backend
 * via bubblewrap (`bwrap`) is implemented and fail-closed; the arg-builder is
 * unit-tested and live write-confinement is asserted by a Linux CI test
 * (test/smoke.ts, Ubuntu leg). Treat the Linux path as experimental.
 *
 * HONESTY CONTRACT: if a sandbox is requested but unavailable, the caller MUST
 * refuse to run — never silently execute unconfined. `sandboxAvailable()` is how
 * the caller checks before relying on confinement.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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

/**
 * True where real kernel confinement is available: macOS (sandbox-exec) or Linux
 * with bubblewrap installed. Fail-closed everywhere else, so callers refuse rather
 * than run unconfined.
 */
export function sandboxAvailable(): boolean {
  if (process.platform === "darwin") return existsSync(SANDBOX_EXEC);
  if (process.platform === "linux") return hasBwrap();
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
 * Wrap `command` so it runs under the platform sandbox. The result is a shell
 * command line (run via the normal shell:true path). Throws if a writable path is
 * unsafe or the platform is unsupported; callers must have checked sandboxAvailable().
 */
export function wrapCommand(command: string, cwd: string, opts: SandboxOpts = {}): string {
  if (process.platform === "darwin") {
    const profile = buildProfile(cwd, opts);
    return `${SANDBOX_EXEC} -p ${shQuote(profile)} /bin/sh -c ${shQuote(command)}`;
  }
  if (process.platform === "linux") {
    return buildBwrapArgs(command, cwd, opts);
  }
  throw new Error(`sandbox not supported on platform: ${process.platform}`);
}

/** Best-effort self-check that the toolchain can actually confine (used by tests). */
export function sandboxSelfTest(): boolean {
  if (!sandboxAvailable()) return false;
  try {
    execFileSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
