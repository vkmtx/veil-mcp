/**
 * Best-effort PATH hardening for the helper binaries we invoke ourselves (rsync,
 * diff, strace, bwrap, …): resolve a name to an ABSOLUTE path in a standard system
 * location so a poisoned $PATH can't substitute a fake. Returns the first existing
 * `<dir>/<name>` from an ordered list of conventional dirs, else the bare `name`
 * (so behavior never regresses where the helper lives elsewhere on PATH). Result is
 * cached per name, probed once per process.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const STD_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin", "/sbin", "/usr/sbin"];

const cache = new Map<string, string>();

export function resolveBin(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let resolved = name;
  for (const dir of STD_DIRS) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      resolved = candidate;
      break;
    }
  }
  cache.set(name, resolved);
  return resolved;
}
