/** Tunables. All overridable via env so behavior can be tuned without a rebuild. */

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  // Floor at 0: every tunable here is a count / size / duration where a negative is
  // meaningless and would misbehave downstream (a negative head/tail slice, etc.).
  // 0 stays 0 — it has meaning for several (no timeout, unbounded cap/records).
  return Number.isFinite(n) ? Math.max(0, n) : def;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "1" || v.toLowerCase() === "true";
}

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined ? def : v;
}

export const config = {
  /** stdout shorter than this (in lines) is returned whole. */
  inlineMaxLines: num("VEIL_INLINE_MAX_LINES", 45),
  /** lines kept from the top when condensing. */
  headLines: num("VEIL_HEAD_LINES", 20),
  /** lines kept from the bottom when condensing. */
  tailLines: num("VEIL_TAIL_LINES", 20),
  /** max chars of any single inline line; longer lines are capped with a pointer
   *  (condensing is line-based, so without this a 1-line megablob would dump whole). */
  maxLineChars: num("VEIL_MAX_LINE_CHARS", 1000),
  /** on failure, show up to this many stderr lines inline before condensing. */
  stderrInlineOnFail: num("VEIL_STDERR_INLINE_ON_FAIL", 60),
  /** default per-command timeout (ms). 0 = no timeout. */
  defaultTimeoutMs: num("VEIL_TIMEOUT_MS", 120_000),
  /** max bytes of each stream stored per run (older bytes dropped). 0 = unbounded. */
  maxStreamBytes: num("VEIL_MAX_STREAM_BYTES", 5_000_000),
  /** max number of run records kept addressable (oldest evicted). 0 = unbounded. */
  maxRecords: num("VEIL_MAX_RECORDS", 500),
  /** max total bytes of the on-disk record store (oldest evicted). 0 = unbounded. */
  maxStoreBytes: num("VEIL_MAX_STORE_BYTES", 256 * 1024 * 1024),
  /** base dir for the on-disk record store, so sh_detail survives a server restart.
   *  "" = auto (XDG_STATE_HOME/veil, else ~/.local/state/veil, else $TMPDIR/veil).
   *  "none"/"off"/"memory" = disable disk, keep records in memory only. */
  stateDir: str("VEIL_STATE_DIR", ""),
  /** persisted records older than this (ms) are pruned on boot. 0 = keep forever. */
  recordTtlMs: num("VEIL_RECORD_TTL_MS", 24 * 60 * 60 * 1000),
  /** compute the git effect-diff (two `git status` calls per run). Disable in huge
   *  repos where that is too slow; a `changed` assertion still forces it. */
  effects: bool("VEIL_EFFECTS", true),
  /** max number of LIVE background processes (sh_run background:true) allowed at once.
   *  A new background run past this is refused (bg_limit_reached) rather than spawned,
   *  so a runaway agent can't fork unbounded dev servers. 0 = unbounded. */
  maxBgProcs: num("VEIL_MAX_BG_PROCS", 16),
} as const;
